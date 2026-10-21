// What Psiphon is doing, read from its own notices, and who is using it.
// Plain functions and small classes, no Shell and no I/O, so all of it runs
// under plain gjs in tests.

// --- Psiphon's notices --------------------------------------------------------

// Psiphon writes one JSON notice per line to stderr, and psi-on sends stderr
// to the log. A new run truncates the log, so the log is the story of the
// process that is running now (or ran last).
export class NoticeLog {
    constructor() {
        this.reset();
    }

    reset() {
        this.http = null;           // listening ports, as Psiphon reports them
        this.socks = null;
        this.tunnels = 0;
        this.region = null;         // server region of the tunnel in use, or of the last one
        this.upAt = null;           // when the tunnel in use came up
        this.firstUpAt = null;
        this.downAt = null;         // when the last tunnel went away, while there is none
        this.drops = 0;             // tunnels lost while running, not counting the goodbye
        this.regionChanges = 0;
        this.startAt = null;        // the first notice of the run
        this.exited = false;        // Psiphon said goodbye: "Exiting"
        this.problem = null;        // {kind: 'port', port} | {kind: 'alert', message}
        this.regions = [];
        this._rest = '';
    }

    // Feeds new text from the log; returns true if anything changed.
    feed(text) {
        const lines = (this._rest + text).split('\n');
        this._rest = lines.pop();
        let changed = false;
        for (const line of lines)
            changed = this._line(line) || changed;
        return changed;
    }

    _line(line) {
        // A run that outlives a truncated log keeps writing at its old offset:
        // the gap reads back as NUL bytes.
        line = line.replace(/\0/g, '').trim();
        if (!line.startsWith('{'))
            return false;
        let n;
        try {
            n = JSON.parse(line);
        } catch {
            return false;
        }
        if (typeof n?.noticeType !== 'string')
            return false;
        const at = Date.parse(n.timestamp) / 1000;
        const d = n.data ?? {};
        if (Number.isFinite(at))
            this.startAt ??= at;
        switch (n.noticeType) {
        case 'ListeningHttpProxyPort':
            this.http = d.port ?? null;
            return true;
        case 'ListeningSocksProxyPort':
            this.socks = d.port ?? null;
            return true;
        case 'HttpProxyPortInUse':
        case 'SocksProxyPortInUse':
            this.problem = {kind: 'port', port: d.port ?? null};
            return true;
        case 'Tunnels': {
            const count = Math.max(0, Number(d.count) || 0);
            if (count > 0 && this.tunnels === 0) {
                this.upAt = at;
                this.firstUpAt ??= at;
                this.downAt = null;
            } else if (count === 0 && this.tunnels > 0) {
                this.upAt = null;
                this.downAt = at;
                this.drops++;
            }
            this.tunnels = count;
            return true;
        }
        case 'ConnectedServerRegion': {
            const region = d.serverRegion || null;
            if (region && this.region && region !== this.region)
                this.regionChanges++;
            this.region = region ?? this.region;
            return true;
        }
        case 'AvailableEgressRegions':
            this.regions = Array.isArray(d.regions) ? d.regions : [];
            return true;
        case 'Exiting':
            // the last tunnel closes right before the goodbye: that is not a drop
            if (this.downAt !== null && at - this.downAt < 5)
                this.drops = Math.max(0, this.drops - 1);
            this.exited = true;
            return true;
        case 'Alert':
        case 'Error':
            if (d.message)
                this.problem = {kind: 'alert', message: String(d.message)};
            return true;
        default:
            return false;
        }
    }
}

// --- what the popup shows -----------------------------------------------------

export const STATES = ['off', 'starting', 'connecting', 'on', 'reconnecting', 'stopping', 'failed'];

// alive: the process is there. action: what we are doing to it ('start',
// 'stop' or null). failure: why it ended when it was not asked to.
export function tunnelState({alive, log, action, failure}) {
    if (action === 'stop')
        return 'stopping';
    if (!alive)
        return action === 'start' ? 'starting' : failure ? 'failed' : 'off';
    if (log.tunnels > 0)
        return 'on';
    if (log.firstUpAt !== null)
        return 'reconnecting';
    return log.http === null ? 'starting' : 'connecting';
}

// Why a run ended, when nobody here asked it to. null: it said goodbye.
export function failureOf(log) {
    if (log.exited)
        return null;
    if (log.problem?.kind === 'port')
        return log.problem;
    return {kind: 'crash', message: log.problem?.message ?? null};
}

// --- regions ------------------------------------------------------------------

// What Psiphon offered on 2026-10-21, for before it has said so itself: it
// lists its regions in an AvailableEgressRegions notice on every run.
export const DEFAULT_REGIONS = ['AT', 'AU', 'BE', 'CA', 'CH', 'CZ', 'DE', 'DK', 'ES', 'FI', 'FR', 'GB',
    'ID', 'IE', 'IN', 'IT', 'JP', 'KR', 'LT', 'NL', 'NO', 'PL', 'RO', 'RS', 'SE', 'SG', 'US'];

export const isRegion = code => /^[A-Z]{2}$/.test(code ?? '');

// Two regional indicator letters make a flag emoji.
export function flagEmoji(code) {
    if (!isRegion(code))
        return '';
    return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

// client.conf with EgressRegion set to code ('' lets Psiphon pick the fastest
// server), everything else as it was: the one value is replaced in place, so
// the file keeps its layout. -> the new text. Throws if the text is not a
// JSON object.
export function setEgressRegion(text, code) {
    if (code !== '' && !isRegion(code))
        throw new Error(`not a region: ${code}`);
    const conf = JSON.parse(text);
    if (!conf || typeof conf !== 'object' || Array.isArray(conf))
        throw new Error('not a JSON object');
    const want = {...conf, EgressRegion: code};
    // the same settings, whatever the order of the keys
    const canon = o => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const same = t => {
        try {
            return canon(JSON.parse(t)) === canon(want);
        } catch {
            return false;
        }
    };
    const value = /("EgressRegion"\s*:\s*)"(?:[^"\\]|\\.)*"/;
    let out;
    if (value.test(text)) {
        out = text.replace(value, (_m, key) => `${key}"${code}"`);
    } else if (!Object.keys(conf).length) {
        out = `{"EgressRegion": "${code}"}\n`;
    } else {
        const indent = /^\s*\{\s*?\n([ \t]*)"/.exec(text)?.[1];
        out = indent !== undefined
            ? text.replace('{', `{\n${indent}"EgressRegion": "${code}",`)
            : text.replace('{', `{"EgressRegion": "${code}", `);
    }
    // the name inside a nested object, a layout the edit got wrong: write it out whole
    if (!same(out))
        out = `${JSON.stringify(want, null, 4)}\n`;
    return out;
}

// --- who uses the tunnel ------------------------------------------------------

const PROXY_VAR = /^(?:https?|all)_proxy$/i;

// Loopback ports a process is told to use as a proxy, from the NUL-separated
// text of /proc/<pid>/environ.
export function proxyPorts(environ) {
    const ports = new Set();
    for (const entry of environ.split('\0')) {
        const eq = entry.indexOf('=');
        if (eq < 0 || !PROXY_VAR.test(entry.slice(0, eq)))
            continue;
        const m = /^(?:[a-z0-9+]+:\/\/)?(?:[^@/]*@)?(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]):(\d+)/i
            .exec(entry.slice(eq + 1).trim());
        if (m)
            ports.add(Number(m[1]));
    }
    return ports;
}

const portOf = addr => Number(addr.slice(addr.lastIndexOf(':') + 1));

// Sockets of programs connected to the given ports, from
// `ss -tinpH state established '( dport = :A or dport = :B )'`.
// rx: bytes the program got through the tunnel, tx: bytes it sent.
export function parseSockets(text, ports) {
    const out = [];
    let last = null;
    for (const line of text.split('\n')) {
        if (/^\s/.test(line) && last) {
            const rx = /\bbytes_received:(\d+)/.exec(line);
            const tx = /\bbytes_acked:(\d+)/.exec(line);
            if (rx)
                last.rx = Number(rx[1]);
            if (tx)
                last.tx = Number(tx[1]);
            continue;
        }
        const m = /^(?:ESTAB\s+)?\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+users:\(\((.*)\)\))?/.exec(line);
        last = null;
        if (!m || !ports.includes(portOf(m[2])))
            continue;
        const user = /"((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(m[3] ?? '');
        last = {
            key: `${m[1]}>${m[2]}`,
            port: portOf(m[2]),
            pid: user ? Number(user[2]) : null,
            comm: user ? user[1] : null,
            rx: 0,
            tx: 0,
        };
        out.push(last);
    }
    return out;
}

// Bytes per second through the tunnel, from the change between two looks at
// the sockets. A socket that is new since the last look moved all its bytes
// in between; one that closed in between takes its last bytes with it.
export class Meter {
    constructor() {
        this._prev = new Map();
        this._at = null;
    }

    reset() {
        this._prev.clear();
        this._at = null;
    }

    // -> null on the first look, else {down, up, byPid: Map(pid -> {down, up})}
    sample(sockets, at) {
        const prev = this._prev, dt = this._at === null ? 0 : at - this._at;
        this._prev = new Map(sockets.map(s => [s.key, s]));
        this._at = at;
        if (dt <= 0)
            return null;
        let down = 0, up = 0;
        const byPid = new Map();
        for (const s of sockets) {
            const p = prev.get(s.key);
            const dr = Math.max(0, s.rx - (p?.rx ?? 0)), du = Math.max(0, s.tx - (p?.tx ?? 0));
            down += dr;
            up += du;
            if (s.pid !== null) {
                const r = byPid.get(s.pid) ?? {down: 0, up: 0};
                r.down += dr / dt;
                r.up += du / dt;
                byPid.set(s.pid, r);
            }
        }
        return {down: down / dt, up: up / dt, byPid};
    }
}

// Names people know a program by. Matched against the command name.
const KNOWN = [
    [/^claude$/, 'Claude Code'],
    [/^codex/, 'Codex'],
    [/^firefox/, 'Firefox'],
    [/^(?:chrome|google-chrome)/, 'Google Chrome'],
    [/^chromium/, 'Chromium'],
    [/^telegram/i, 'Telegram'],
    [/^curl$/, 'curl'],
    [/^wget$/, 'wget'],
    [/^git(?:-remote-https?)?$/, 'git'],
];

export function knownName(comm) {
    for (const [re, name] of KNOWN) {
        if (re.test(comm ?? ''))
            return name;
    }
    return null;
}

// The programs to show for a set of processes: a process whose parent is in
// the set too is part of its parent (Claude's shells and MCP servers are
// Claude). procs: Map(pid -> {ppid, comm}).
export function roots(pids, procs) {
    const set = new Set(pids);
    const out = new Set();
    for (const pid of set) {
        let p = pid, guard = 0;
        while (guard++ < 64) {
            const parent = procs.get(p)?.ppid;
            if (!parent || !set.has(parent))
                break;
            p = parent;
        }
        out.add(p);
    }
    return [...out];
}

// --- listening ports ------------------------------------------------------------

// Ports in LISTEN that keep Psiphon from binding 127.0.0.1, from
// /proc/net/tcp or tcp6: the wildcard address or a 127.x one. Addresses
// there are hex in host byte order, so 127.0.0.1 reads 0100007F.
export function listeningPorts(text) {
    const out = new Set();
    for (const line of text.split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 4 || f[3] !== '0A')
            continue;
        const [addr, port] = f[1].split(':');
        const v4 = addr.length === 8 && (/^0+$/.test(addr) || /7F$/i.test(addr));
        const v6 = addr.length === 32 && (/^0+$/.test(addr) || /^0{16}FFFF0000[0-9A-F]{6}7F$/i.test(addr));
        if (v4 || v6)
            out.add(parseInt(port, 16));
    }
    return out;
}

// --- stopping ---------------------------------------------------------------------

// Stops a process the polite way: SIGTERM, a few seconds to close its tunnels
// and say goodbye, SIGKILL only if it hangs. ops: {alive(), signal(name),
// sleep(ms), now() in ms}. -> {how: 'gone' | 'term' | 'kill' | 'stuck', ms}
export async function stopProcess(ops, {grace = 5000, poll = 50, killWait = 2000} = {}) {
    const t0 = ops.now();
    if (!ops.alive())
        return {how: 'gone', ms: 0};
    await ops.signal('TERM');
    while (ops.now() - t0 < grace) {
        await ops.sleep(poll);
        if (!ops.alive())
            return {how: 'term', ms: ops.now() - t0};
    }
    await ops.signal('KILL');
    const t1 = ops.now();
    while (ops.now() - t1 < killWait) {
        await ops.sleep(poll);
        if (!ops.alive())
            return {how: 'kill', ms: ops.now() - t0};
    }
    return {how: 'stuck', ms: ops.now() - t0};
}

// --- clock ------------------------------------------------------------------------

// "0:07", "12:40", "1:02:03"
export function formatClock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
    const two = v => String(v).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}
