// The real thing against a fake Psiphon: start, adopt, stop, crash. Each test
// gets its own directory and ports, so a real Psiphon nearby is never touched.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Psiphon, busyPorts, findPsiphon, procStat, sleep, stillRunning, writeRegion} from '../psiphon-tunnel@terentiy/psiphon.js';
import {cleanup, home, read, until, userSystemd} from './fake.js';
import {assert, equal, test} from './harness.js';

test('starts like psi-on: own session, log, pid file, and it outlives us', async () => {
    const {paths, http} = await home();
    const p = new Psiphon(paths, () => {});
    try {
        equal(p.state, 'off');
        await p.start();
        assert(p.proc, `not started: ${JSON.stringify(p.failure)}`);
        equal(read(paths.pidfile).trim(), String(p.proc.pid));
        assert(await until(() => p.poll() || p.state === 'on'), `state ${p.state}`);
        equal(p.state, 'on');
        equal(p.log.region, 'NO');
        equal(p.ports.http, http);
        // its own session, and not our child: a Shell restart cannot take it down
        const st = procStat(p.proc.pid);
        const sid = Number(read(`/proc/${p.proc.pid}/stat`).slice(read(`/proc/${p.proc.pid}/stat`).lastIndexOf(')') + 2).split(' ')[3]);
        equal(sid, p.proc.pid, 'session leader');
        assert(st.ppid !== new Gio.Credentials().get_unix_pid(), 'reparented away from us');
        // and out of our cgroup, where a user systemd can give it a scope
        const cgroup = read(`/proc/${p.proc.pid}/cgroup`);
        if (await userSystemd())
            assert(/\/app-psiphon-tunnel-\d+\.scope$/m.test(cgroup), `cgroup ${cgroup}`);
        else
            print('     (no user systemd here: setsid only)');
    } finally {
        cleanup(p);
    }
});

test('stops politely: SIGTERM, a goodbye in the log, ports free, pid file gone', async () => {
    const {paths, http} = await home();
    const p = new Psiphon(paths, () => {});
    try {
        await p.start();
        await until(() => p.poll() || p.state === 'on');
        const proc = p.proc;
        const r = await p.stop();
        equal(r.how, 'term');
        assert(r.ms < 1000, `took ${r.ms} ms`);
        assert(!stillRunning(proc));
        equal(p.state, 'off');
        equal(p.failure, null);
        assert(p.log.exited, 'Psiphon said goodbye');
        equal(p.log.drops, 0, 'the goodbye is not a drop');
        assert(!busyPorts().has(http), 'port released');
        assert(!GLib.file_test(paths.pidfile, GLib.FileTest.EXISTS), 'pid file removed');
    } finally {
        cleanup(p);
    }
});

test('a Psiphon that ignores SIGTERM is killed after the grace period', async () => {
    const {paths} = await home();
    GLib.setenv('FAKE_IGNORE_TERM', '1', true);
    const p = new Psiphon(paths, () => {});
    try {
        await p.start();
        await until(() => p.poll() || p.state === 'on');
        const r = await p.stop({grace: 600});
        equal(r.how, 'kill');
        assert(r.ms >= 600, `took ${r.ms} ms`);
        equal(p.state, 'off');
        assert(findPsiphon(paths).length === 0);
    } finally {
        GLib.unsetenv('FAKE_IGNORE_TERM');
        cleanup(p);
    }
});

test('a Psiphon started from the terminal is found, read and stopped', async () => {
    const {paths} = await home();
    // exactly psi-on, relative config path and all
    const sh = Gio.Subprocess.new(['/bin/sh', '-c',
        `cd "${GLib.path_get_dirname(paths.conf)}"; nohup ./psiphon -config client.conf > psiphon.log 2>&1 & echo $! > psiphon.pid`],
    Gio.SubprocessFlags.NONE);
    await sh.wait_check_async(null);
    await sleep(400);
    const p = new Psiphon(paths, () => {});
    try {
        assert(p.proc, 'found');
        equal(String(p.proc.pid), read(paths.pidfile).trim());
        equal(p.state, 'on');
        const r = await p.stop();
        equal(r.how, 'term');
    } finally {
        cleanup(p);
    }
});

test('a crash is told apart from a goodbye', async () => {
    const {paths} = await home();
    GLib.setenv('FAKE_CRASH_MS', '300', true);
    const p = new Psiphon(paths, () => {});
    try {
        await p.start();
        GLib.unsetenv('FAKE_CRASH_MS');
        assert(await until(() => {
            p.poll();
            return p.state === 'failed';
        }), `state ${p.state}`);
        equal(p.failure.kind, 'crash');
        equal(p.ended.failure.kind, 'crash');
    } finally {
        GLib.unsetenv('FAKE_CRASH_MS');
        cleanup(p);
    }
});

test('a busy port is caught before starting', async () => {
    const {paths, http} = await home();
    const other = await home();
    // another program on our HTTP port
    GLib.file_set_contents(other.paths.conf, JSON.stringify({LocalHttpProxyPort: http, LocalSocksProxyPort: other.socks}));
    const blocker = new Psiphon(other.paths, () => {});
    const p = new Psiphon(paths, () => {});
    try {
        await blocker.start();
        await until(() => busyPorts().has(http));
        await p.start();
        equal(p.proc, null);
        equal(p.state, 'failed');
        equal(p.failure.kind, 'port');
        equal(p.failure.port, http);
    } finally {
        cleanup(blocker);
        cleanup(p);
    }
});

test('never mistakes a different Psiphon for ours', async () => {
    const a = await home();
    const b = await home();
    const pa = new Psiphon(a.paths, () => {});
    const pb = new Psiphon(b.paths, () => {});
    try {
        await pa.start();
        equal(pb.proc, null);
        pb.rescan();
        equal(pb.proc, null, 'another binary and config is not ours');
        // and the real ~/psiphon, if it runs on this machine, is invisible here
        const pids = findPsiphon(a.paths).map(x => x.pid);
        equal(pids.length, 1);
        equal(pids[0], pa.proc.pid);
    } finally {
        cleanup(pa);
        cleanup(pb);
    }
});

test('a country goes into client.conf with its permissions, and Psiphon takes it on the next start', async () => {
    const {paths, http, socks} = await home();
    const layout = `{\n"LocalHttpProxyPort": ${http},\n"LocalSocksProxyPort": ${socks},\n"EgressRegion": ""\n}\n`;
    GLib.file_set_contents(paths.conf, layout);
    GLib.chmod(paths.conf, 0o600);
    const p = new Psiphon(paths, () => {});
    try {
        assert(writeRegion(paths.conf, 'SE'), 'changed');
        equal(read(paths.conf), layout.replace('"EgressRegion": ""', '"EgressRegion": "SE"'));
        const mode = Gio.File.new_for_path(paths.conf).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_uint32('unix::mode') & 0o777;
        equal(mode, 0o600, 'permissions kept');
        assert(!writeRegion(paths.conf, 'SE'), 'the same country is not a change');
        await p.start();
        assert(await until(() => p.poll() || p.state === 'on'), `state ${p.state}`);
        equal(p.log.region, 'SE');
        equal(p.log.regions.join(), 'DE,NL,NO,SE,US');
    } finally {
        cleanup(p);
    }
});
