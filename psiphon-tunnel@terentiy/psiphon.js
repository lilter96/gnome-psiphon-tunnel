// Psiphon itself: finding it, starting it the way psi-on does, stopping it
// politely, following its log, and seeing who goes through it. GLib and Gio
// only, so the tests drive it under plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {
    Meter, NoticeLog, failureOf, knownName, listeningPorts, parseSockets, proxyPorts, roots,
    stopProcess, tunnelState,
} from './tunnel.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Soup.Session.prototype, 'send_async');

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'NO_PROXY', 'no_proxy'];
const TICKS = 100;   // USER_HZ: /proc counts process start times in these

const nowMs = () => GLib.get_monotonic_time() / 1000;
export const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

// The files psi-on uses, all under ~/psiphon, and where it runs from.
export function defaultPaths(home = GLib.get_home_dir()) {
    const dir = GLib.build_filenamev([home, 'psiphon']);
    return {
        bin: GLib.build_filenamev([dir, 'psiphon']),
        conf: GLib.build_filenamev([dir, 'client.conf']),
        log: GLib.build_filenamev([dir, 'psiphon.log']),
        pidfile: GLib.build_filenamev([dir, 'psiphon.pid']),
        // psi-on runs from a fresh terminal, so Psiphon keeps its data in ~
        cwd: home,
    };
}

function read(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

function resolve(path) {
    // follow symlinks all the way, like readlink -f
    let p = GLib.canonicalize_filename(path, null);
    for (let i = 0; i < 16; i++) {
        let target;
        try {
            target = GLib.file_read_link(p);
        } catch {
            return p;
        }
        p = GLib.canonicalize_filename(target, GLib.path_get_dirname(p));
    }
    return p;
}

// --- processes --------------------------------------------------------------------

// pid, parent, name, state and start time (in ticks since boot) of a process.
export function procStat(pid) {
    const text = read(`/proc/${pid}/stat`);
    if (!text)
        return null;
    const close = text.lastIndexOf(')');
    const f = text.slice(close + 2).split(' ');
    return {
        pid,
        comm: text.slice(text.indexOf('(') + 1, close),
        state: f[0],
        ppid: Number(f[1]),
        start: Number(f[19]),
    };
}

let btime = null;
// Wall-clock seconds at which a process started.
export function startedAt(start) {
    btime ??= Number(/^btime (\d+)/m.exec(read('/proc/stat') ?? '')?.[1] ?? 0);
    return btime + start / TICKS;
}

function allPids() {
    const pids = [];
    try {
        const e = Gio.File.new_for_path('/proc').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = e.next_file(null))) {
            const name = info.get_name();
            if (/^\d+$/.test(name))
                pids.push(Number(name));
        }
        e.close(null);
    } catch {}
    return pids;
}

function exeOf(pid) {
    try {
        return GLib.file_read_link(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    } catch {
        return null;
    }
}

// Is this process the Psiphon of these paths: the same binary, the same config?
export function isPsiphon(pid, paths) {
    const exe = exeOf(pid);
    if (!exe || exe !== resolve(paths.bin))
        return false;
    const args = (read(`/proc/${pid}/cmdline`) ?? '').split('\0');
    const i = args.findIndex(a => a === '-config' || a === '--config');
    let conf = i >= 0 ? args[i + 1] : args.find(a => /^--?config=/.test(a))?.replace(/^--?config=/, '');
    if (!conf)
        return false;
    if (!GLib.path_is_absolute(conf)) {
        let cwd;
        try {
            cwd = GLib.file_read_link(`/proc/${pid}/cwd`);
        } catch {
            return false;
        }
        conf = GLib.build_filenamev([cwd, conf]);
    }
    return resolve(conf) === resolve(paths.conf);
}

// The running Psiphons of these paths, the one in the pid file first.
export function findPsiphon(paths) {
    const pidfile = Number((read(paths.pidfile) ?? '').trim());
    const pids = allPids().sort((a, b) => (b === pidfile) - (a === pidfile));
    const found = [];
    for (const pid of pids) {
        const st = procStat(pid);
        if (st && st.state !== 'Z' && isPsiphon(pid, paths))
            found.push({pid, start: st.start});
    }
    return found;
}

// Still the same process: not gone, not a zombie, not a new one on a reused pid.
export function stillRunning(p) {
    const st = procStat(p.pid);
    return !!st && st.state !== 'Z' && st.start === p.start;
}

async function signal(pid, name) {
    const proc = Gio.Subprocess.new(['kill', '-s', name, String(pid)],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    await proc.wait_async(null);
}

// Ports some program is listening on, where Psiphon would want to.
export function busyPorts() {
    const out = new Set();
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6'])
        listeningPorts(read(f) ?? '').forEach(p => out.add(p));
    return out;
}

// Ports from client.conf, for when Psiphon has not reported its own.
export function configPorts(conf) {
    try {
        const c = JSON.parse(read(conf) ?? 'null');
        return {http: c?.LocalHttpProxyPort || null, socks: c?.LocalSocksProxyPort || null,
            region: c?.EgressRegion || null};
    } catch {
        return {http: null, socks: null, region: null};
    }
}

// --- Psiphon ----------------------------------------------------------------------

// The same thing psi-on does, made to outlive the Shell. The Shell's service
// has KillMode=control-group and Restart=always: when it crashes, systemd
// kills everything in its cgroup, a Psiphon started from it too. So Psiphon
// gets a scope of its own, the way GNOME starts apps (systemd-run execs it,
// the pid stays the same), and its own session. Without a user systemd it is
// setsid alone. sh exits at once either way.
const LAUNCH = `cd "$1" || exit 1
if systemd-run --user --scope --quiet --collect true </dev/null >/dev/null 2>&1; then
    setsid systemd-run --user --scope --quiet --collect --unit="app-psiphon-tunnel-$$" \\
        --description=Psiphon -- "$2" -config "$3" </dev/null >"$4" 2>&1 &
else
    setsid "$2" -config "$3" </dev/null >"$4" 2>&1 &
fi
echo $!`;

export class Psiphon {
    constructor(paths, onChange) {
        this.paths = paths;
        this._onChange = onChange;
        this.log = new NoticeLog();
        this.proc = null;           // {pid, start}
        this.extra = [];            // more copies with the same config, if any
        this.action = null;         // 'start' | 'stop'
        this.failure = null;        // why the last run ended by itself
        this.lastStop = null;       // {how, ms}
        this._offset = 0;
        this._file = Gio.File.new_for_path(paths.log);
        try {
            this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', () => this._readLog() && this._changed());
        } catch {
            this._monitor = null;
        }
        this.rescan();
        this._readLog();
    }

    destroy() {
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
        }
        this._monitor = null;
        this._onChange = null;
    }

    _changed() {
        this._onChange?.();
    }

    get state() {
        return tunnelState({alive: !!this.proc, log: this.log, action: this.action, failure: this.failure});
    }

    get ports() {
        const c = configPorts(this.paths.conf);
        return {http: this.log.http ?? c.http, socks: this.log.socks ?? c.socks};
    }

    get startedAt() {
        return this.proc ? startedAt(this.proc.start) : null;
    }

    rescan() {
        const found = findPsiphon(this.paths);
        const keep = this.proc && found.find(p => p.pid === this.proc.pid && p.start === this.proc.start);
        const was = this.proc;
        this.proc = keep ?? found[0] ?? null;
        this.extra = found.filter(p => p !== this.proc);
        if (this.proc && (!was || was.pid !== this.proc.pid))
            this.failure = null;
        return this.proc !== was;
    }

    // Reads what Psiphon wrote since the last look. -> true if anything changed
    _readLog() {
        let size;
        try {
            size = this._file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        } catch {
            return false;
        }
        let changed = false;
        if (size < this._offset) {
            // A new run truncated the log. If ours is still alive, the log was
            // cut by a run that failed next to it (psi-on twice): keep what we know.
            if (this.proc && stillRunning(this.proc)) {
                this._offset = size;
                return false;
            }
            this.log.reset();
            this._offset = 0;
            changed = this.rescan() || true;
        }
        if (size === this._offset)
            return changed;
        try {
            const stream = this._file.read(null);
            stream.seek(this._offset, GLib.SeekType.SET, null);
            const bytes = stream.read_bytes(size - this._offset, null);
            stream.close(null);
            this._offset += bytes.get_size();
            changed = this.log.feed(new TextDecoder().decode(bytes.toArray())) || changed;
        } catch {}
        return changed;
    }

    // Every couple of seconds: is it still there, did someone start it.
    poll(rescan = false) {
        let changed = this._readLog();
        if (this.proc && !stillRunning(this.proc)) {
            const gone = this.proc;
            this.rescan();
            if (!this.proc && this.action !== 'stop') {
                // its last words may still be on the way
                this._readLog();
                this.failure = failureOf(this.log);
                this.ended = {pid: gone.pid, failure: this.failure};
            }
            changed = true;
        } else if (!this.proc && rescan) {
            changed = this.rescan() || changed;
        }
        if (changed)
            this._changed();
        return changed;
    }

    // Starts Psiphon like psi-on: same binary, same config, same log, same pid file.
    async start() {
        if (this.action || (this.proc && stillRunning(this.proc)))
            return;
        const {http, socks} = configPorts(this.paths.conf);
        const busy = busyPorts();
        const taken = [http, socks].find(p => p && busy.has(p));
        if (taken) {
            this.failure = {kind: 'port', port: taken};
            this._changed();
            return;
        }
        if (!GLib.file_test(this.paths.bin, GLib.FileTest.IS_EXECUTABLE)) {
            this.failure = {kind: 'missing', path: this.paths.bin};
            this._changed();
            return;
        }
        this.action = 'start';
        this.failure = null;
        this.ended = null;
        this.log.reset();
        this._offset = 0;
        this._changed();
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE});
            for (const v of PROXY_VARS)
                launcher.unsetenv(v);
            const sh = launcher.spawnv(['/bin/sh', '-c', LAUNCH, 'sh',
                this.paths.cwd, this.paths.bin, this.paths.conf, this.paths.log]);
            const [out] = await sh.communicate_utf8_async(null, null);
            const pid = Number(out.trim());
            // wait for the exec: until then /proc shows sh or setsid
            let st = null;
            for (let i = 0; i < 80 && pid > 0; i++) {
                st = procStat(pid);
                if (!st || isPsiphon(pid, this.paths))
                    break;
                await sleep(25);
            }
            if (st && st.state !== 'Z' && isPsiphon(pid, this.paths)) {
                this.proc = {pid, start: st.start};
                GLib.file_set_contents(this.paths.pidfile, `${pid}\n`);
            } else {
                // gone already: a busy port, a bad config
                await sleep(100);
                this._readLog();
                this.failure = failureOf(this.log);
            }
        } catch (e) {
            this.failure = {kind: 'crash', message: e.message};
        } finally {
            this.action = null;
            this._readLog();
            this._changed();
        }
    }

    // Stops every copy with our config: SIGTERM first, SIGKILL only if one
    // hangs. -> {how, ms} of the slowest, or null if there was nothing to stop
    async stop({grace = 5000} = {}) {
        if (this.action === 'stop')
            return null;
        const all = findPsiphon(this.paths);
        if (!all.length) {
            this.proc = null;
            this._changed();
            return null;
        }
        this.action = 'stop';
        this._changed();
        let worst = null;
        try {
            const results = await Promise.all(all.map(p => stopProcess({
                alive: () => stillRunning(p),
                signal: name => stillRunning(p) && isPsiphon(p.pid, this.paths)
                    ? signal(p.pid, name) : Promise.resolve(),
                sleep,
                now: nowMs,
            }, {grace})));
            const rank = {gone: 0, term: 1, kill: 2, stuck: 3};
            worst = results.reduce((a, b) => rank[b.how] > rank[a.how] || (rank[b.how] === rank[a.how] && b.ms > a.ms) ? b : a);
            // the pid file is psi-off's: leave it only if it names someone else
            const named = Number((read(this.paths.pidfile) ?? '').trim());
            if (all.some(p => p.pid === named) && worst.how !== 'stuck')
                GLib.unlink(this.paths.pidfile);
        } finally {
            this._readLog();
            this.lastStop = worst;
            this.action = null;
            this.failure = null;
            this.ended = null;
            this.rescan();
            this._changed();
        }
        return worst;
    }
}

// --- who goes through the tunnel ----------------------------------------------------

async function run(argv) {
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [out] = await proc.communicate_utf8_async(null, null);
    return out ?? '';
}

// Programs that use the tunnel: the ones told to by their environment (the
// claude and codex wrappers), and the ones caught connected to it (a browser
// set to the SOCKS port). A program caught once counts until it exits: it
// will be back.
export class Users {
    constructor({self = null, exclude = () => []} = {}) {
        this._self = self;
        this._exclude = exclude;
        this._seen = new Map();     // pid -> {start, last}
        this._env = new Map();      // pid -> {start}, from the last environment scan
        this._envAt = 0;
        this.meter = new Meter();
        this.rates = null;
    }

    // The environment of every process of the user. A few milliseconds.
    scanEnv(ports) {
        const env = new Map();
        for (const pid of allPids()) {
            if (pid === this._self)
                continue;
            const text = read(`/proc/${pid}/environ`);
            if (!text || !/_proxy=/i.test(text))
                continue;
            const mine = proxyPorts(text);
            if (![...mine].some(p => ports.includes(p)))
                continue;
            const st = procStat(pid);
            if (st)
                env.set(pid, {start: st.start});
        }
        this._env = env;
        this._envAt = nowMs();
    }

    // Who is connected right now, and how fast. ss does the socket-to-process work.
    async sample(ports, now = nowMs() / 1000) {
        const filter = `( ${ports.map(p => `dport = :${p}`).join(' or ')} )`;
        const sockets = parseSockets(await run(['ss', '-tinpH', 'state', 'established', filter]), ports)
            .filter(s => s.pid !== this._self);
        const wall = Date.now() / 1000;
        for (const s of sockets) {
            const st = s.pid ? procStat(s.pid) : null;
            if (st)
                this._seen.set(s.pid, {start: st.start, last: wall});
        }
        this.rates = this.meter.sample(sockets, now);
        this.live = new Set(sockets.map(s => s.pid));
        return this.rates;
    }

    // [{name, comm, pid, pids, env, live, last, down, up}], busiest first;
    // last is wall-clock seconds.
    list() {
        const alive = (pid, start) => {
            const st = procStat(pid);
            return st && st.state !== 'Z' && st.start === start;
        };
        for (const [pid, s] of this._seen) {
            if (!alive(pid, s.start))
                this._seen.delete(pid);
        }
        for (const [pid, s] of this._env) {
            if (!alive(pid, s.start))
                this._env.delete(pid);
        }
        const skip = new Set(this._exclude());
        const pids = [...new Set([...this._env.keys(), ...this._seen.keys()])].filter(p => !skip.has(p));
        // parents up the tree, to fold children into their program
        const procs = new Map();
        const want = [...pids];
        while (want.length && procs.size < 4096) {
            const pid = want.pop();
            if (procs.has(pid) || pid <= 1)
                continue;
            const st = procStat(pid);
            if (!st)
                continue;
            procs.set(pid, st);
            want.push(st.ppid);
        }
        const rootOf = new Map();
        const tops = roots(pids, procs);
        for (const pid of pids) {
            let p = pid;
            while (!tops.includes(p) && procs.get(p))
                p = procs.get(p).ppid;
            rootOf.set(pid, tops.includes(p) ? p : pid);
        }
        const byName = new Map();
        for (const pid of pids) {
            const root = rootOf.get(pid);
            const comm = procs.get(root)?.comm ?? '';
            const name = knownName(comm) ?? comm;
            const u = byName.get(name) ?? {name, comm, pid: root, pids: new Set(), env: false, live: false,
                last: 0, down: 0, up: 0};
            u.pids.add(root);
            u.env ||= this._env.has(pid);
            u.live ||= this.live?.has(pid) ?? false;
            u.last = Math.max(u.last, this._seen.get(pid)?.last ?? 0);
            const r = this.rates?.byPid.get(pid);
            if (r) {
                u.down += r.down;
                u.up += r.up;
            }
            byName.set(name, u);
        }
        return [...byName.values()]
            .map(u => ({...u, pids: [...u.pids], count: u.pids.size}))
            .sort((a, b) => (b.down + b.up) - (a.down + a.up) || b.live - a.live || a.name.localeCompare(b.name));
    }

    get envAge() {
        return (nowMs() - this._envAt) / 1000;
    }
}

// --- is the tunnel any good ----------------------------------------------------------

const PROBE_URL = 'https://www.gstatic.com/generate_204';

// Milliseconds for one request through the tunnel. The first request opens
// the CONNECT and TLS; the second one rides on it and measures the tunnel.
export async function probe(port, cancellable = null) {
    const session = new Soup.Session({
        proxy_resolver: Gio.SimpleProxyResolver.new(`http://127.0.0.1:${port}`, null),
        timeout: 10,
        user_agent: 'psiphon-tunnel-gnome/1',
    });
    try {
        let best = Infinity;
        for (let i = 0; i < 2; i++) {
            const msg = Soup.Message.new('HEAD', PROBE_URL);
            const t0 = nowMs();
            const stream = await session.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
            stream.close(null);
            const status = msg.get_status();
            if (status < 200 || status >= 400)
                throw new Error(`HTTP ${status}`);
            if (i > 0)
                best = nowMs() - t0;
        }
        return Math.round(best);
    } finally {
        session.abort();
    }
}
