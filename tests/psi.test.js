// bin/psi as psi-on and psi-off, against the fake Psiphon. PSI_DIR points it
// at a home of the test's own: a real ~/psiphon is never looked at.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Psiphon, busyPorts, findPsiphon, procStat} from '../psiphon-tunnel@terentiy/psiphon.js';
import {cleanup, home, read, until} from './fake.js';
import {assert, equal, test} from './harness.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const script = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..', 'bin', 'psi']);

// psi-on and psi-off as they are installed: links to bin/psi with those names.
async function psi(paths, name, env = {}) {
    const link = GLib.build_filenamev([paths.cwd, name]);
    if (!GLib.file_test(link, GLib.FileTest.IS_SYMLINK))
        Gio.File.new_for_path(link).make_symbolic_link(GLib.canonicalize_filename(script, null), null);
    const l = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
    l.setenv('HOME', paths.cwd, true);
    l.setenv('PSI_DIR', GLib.path_get_dirname(paths.bin), true);
    for (const [k, v] of Object.entries(env))
        l.setenv(k, v, true);
    const p = l.spawnv([link]);
    const [out, err] = await p.communicate_utf8_async(null, null);
    return {status: p.get_exit_status(), out: out.trim(), err: err.trim()};
}

const stop = paths => cleanup(new Psiphon(paths, () => {}));
const pidOf = out => Number(/pid (\d+)/.exec(out)?.[1]);

test('psi-on starts it the way the extension does, and the extension finds it', async () => {
    const {paths, http} = await home();
    try {
        const r = await psi(paths, 'psi-on');
        equal(r.status, 0, r.err);
        const pid = pidOf(r.out);
        assert(r.out.startsWith('Psiphon started'), r.out);
        equal(read(paths.pidfile).trim(), String(pid));
        const stat = read(`/proc/${pid}/stat`);
        equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3], String(pid), 'session leader');
        assert(await until(() => busyPorts().has(http)), 'listening');
        const p = new Psiphon(paths, () => {});
        equal(p.proc?.pid, pid, 'adopted');
        p.destroy();
    } finally {
        stop(paths);
    }
});

test('psi-on twice keeps the running one and its log', async () => {
    const {paths} = await home();
    try {
        const first = pidOf((await psi(paths, 'psi-on')).out);
        await until(() => /"Tunnels"/.test(read(paths.log) ?? ''));
        const log = read(paths.log);
        GLib.unlink(paths.pidfile);
        const r = await psi(paths, 'psi-on');
        equal(r.status, 0, r.err);
        equal(r.out, `Psiphon is already running (pid ${first})`);
        assert(read(paths.log).startsWith(log), 'the log of the running one is kept');
        equal(read(paths.pidfile).trim(), String(first), 'the pid file is put back');
        equal(findPsiphon(paths).length, 1);
    } finally {
        stop(paths);
    }
});

test('psi-off stops it politely, waits for it and removes the pid file', async () => {
    const {paths, http} = await home();
    try {
        const pid = pidOf((await psi(paths, 'psi-on')).out);
        await until(() => busyPorts().has(http));
        const r = await psi(paths, 'psi-off');
        equal(r.status, 0, r.err);
        assert(/^Psiphon stopped in \d+ ms$/.test(r.out), r.out);
        // gone by the time psi-off returns, not just signalled
        assert(!procStat(pid) || procStat(pid).state === 'Z', 'gone');
        assert(/"Exiting"/.test(read(paths.log)), 'Psiphon said goodbye');
        assert(!busyPorts().has(http), 'port released');
        assert(!GLib.file_test(paths.pidfile, GLib.FileTest.EXISTS), 'pid file removed');
        equal((await psi(paths, 'psi-off')).out, 'Psiphon is not running');
    } finally {
        stop(paths);
    }
});

test('psi-off never kills a stranger named in the pid file', async () => {
    const {paths} = await home();
    const stranger = Gio.Subprocess.new(['sleep', '30'], Gio.SubprocessFlags.NONE);
    try {
        GLib.file_set_contents(paths.pidfile, `${stranger.get_identifier()}\n`);
        const r = await psi(paths, 'psi-off');
        equal(r.out, 'Psiphon is not running');
        assert(procStat(Number(stranger.get_identifier()))?.state !== 'Z', 'the stranger lives');
        assert(!GLib.file_test(paths.pidfile, GLib.FileTest.EXISTS), 'the stale pid file is gone');
    } finally {
        stranger.force_exit();
    }
});

test('psi-off kills a Psiphon that ignores SIGTERM after the grace period', async () => {
    const {paths} = await home();
    try {
        await psi(paths, 'psi-on', {FAKE_IGNORE_TERM: '1'});
        await until(() => /"Tunnels"/.test(read(paths.log) ?? ''));
        const t0 = Date.now();
        const r = await psi(paths, 'psi-off', {PSI_GRACE: '1'});
        equal(r.out, 'Psiphon did not stop in 1 s, killed');
        assert(Date.now() - t0 >= 1000, `took ${Date.now() - t0} ms`);
        equal(findPsiphon(paths).length, 0);
    } finally {
        stop(paths);
    }
});

test('psi-on refuses a taken port and leaves the old log alone', async () => {
    const {paths, http} = await home();
    const other = await home();
    GLib.file_set_contents(other.paths.conf, JSON.stringify({LocalHttpProxyPort: http, LocalSocksProxyPort: other.socks}));
    try {
        await psi(other.paths, 'psi-on');
        await until(() => busyPorts().has(http));
        GLib.file_set_contents(paths.log, 'the last run\n');
        const r = await psi(paths, 'psi-on');
        equal(r.status, 1);
        equal(r.err, `port ${http} is taken by psiphon`);
        equal(findPsiphon(paths).length, 0);
        equal(read(paths.log), 'the last run\n');
    } finally {
        stop(other.paths);
        stop(paths);
    }
});

test('psi-off stops a Psiphon the extension started', async () => {
    const {paths} = await home();
    const p = new Psiphon(paths, () => {});
    try {
        await p.start();
        assert(p.proc, 'started');
        const r = await psi(paths, 'psi-off');
        assert(r.out.startsWith('Psiphon stopped'), r.out);
        equal(findPsiphon(paths).length, 0);
    } finally {
        cleanup(p);
    }
});
