import {LANGUAGES} from '../psiphon-tunnel@terentiy/lang.js';
import {
    Meter, NoticeLog, failureOf, flagEmoji, formatClock, listeningPorts, parseSockets, proxyPorts, roots,
    stopProcess, tunnelState,
} from '../psiphon-tunnel@terentiy/tunnel.js';
import {assert, deepEqual, equal, test} from './harness.js';

const {en, ru} = LANGUAGES;

const notice = (type, data, ts) => JSON.stringify({data, noticeType: type, timestamp: ts});

// A day of a real run, shaped like Psiphon's own log (private bits left out).
const RUN = [
    'nohup: ignoring input',
    notice('NetworkID', {ID: 'UNKNOWN'}, '2026-10-20T08:30:52.458Z'),
    notice('ListeningSocksProxyPort', {port: 1081}, '2026-10-20T08:30:52.460Z'),
    notice('ListeningHttpProxyPort', {port: 8081}, '2026-10-20T08:30:52.460Z'),
    notice('AvailableEgressRegions', {regions: ['DE', 'FR', 'NO']}, '2026-10-20T08:30:52.461Z'),
    notice('SkipServerEntry', {reason: 'restricted provider ID'}, '2026-10-20T08:30:52.470Z'),
    notice('Tunnels', {count: 1}, '2026-10-20T08:30:55.000Z'),
    notice('ConnectedServerRegion', {serverRegion: 'DE'}, '2026-10-20T08:30:55.004Z'),
    notice('Tunnels', {count: 0}, '2026-10-20T12:19:22.000Z'),
    notice('Tunnels', {count: 1}, '2026-10-20T12:19:24.000Z'),
    notice('ConnectedServerRegion', {serverRegion: 'FR'}, '2026-10-20T12:19:24.010Z'),
].join('\n') + '\n';

const at = iso => Date.parse(iso) / 1000;

test('the log tells the ports, the tunnel, the server and the drops', () => {
    const log = new NoticeLog();
    assert(log.feed(RUN));
    equal(log.http, 8081);
    equal(log.socks, 1081);
    equal(log.tunnels, 1);
    equal(log.region, 'FR');
    equal(log.upAt, at('2026-10-20T12:19:24.000Z'));
    equal(log.firstUpAt, at('2026-10-20T08:30:55.000Z'));
    equal(log.drops, 1);
    equal(log.regionChanges, 1);
    deepEqual(log.regions, ['DE', 'FR', 'NO']);
    equal(log.exited, false);
});

test('lines may arrive in pieces', () => {
    const log = new NoticeLog();
    const cut = RUN.indexOf('"Tunnels"') + 5;
    log.feed(RUN.slice(0, cut));
    equal(log.tunnels, 0);
    log.feed(RUN.slice(cut));
    equal(log.tunnels, 1);
    equal(log.region, 'FR');
});

test('the last tunnel closing on the way out is not a drop', () => {
    const log = new NoticeLog();
    log.feed(RUN);
    log.feed(`${notice('Tunnels', {count: 0}, '2026-10-20T20:59:37.000Z')}\n`);
    equal(log.drops, 2);
    log.feed(`${notice('Exiting', {}, '2026-10-20T20:59:37.001Z')}\n`);
    equal(log.drops, 1);
    assert(log.exited);
    equal(failureOf(log), null);
});

test('a busy port is the reason the run ended', () => {
    const log = new NoticeLog();
    log.feed(`${notice('NetworkID', {ID: 'UNKNOWN'}, '2026-10-21T15:33:27.430Z')}\n` +
        `${notice('SocksProxyPortInUse', {port: 1081}, '2026-10-21T15:33:27.431Z')}\n`);
    deepEqual(failureOf(log), {kind: 'port', port: 1081});
});

test('a run that vanished without a goodbye crashed', () => {
    const log = new NoticeLog();
    log.feed(RUN);
    deepEqual(failureOf(log), {kind: 'crash', message: null});
});

test('NUL bytes from a truncated log do not hide the next notice', () => {
    const log = new NoticeLog();
    log.feed(`\0\0\0\0${notice('Tunnels', {count: 1}, '2026-10-20T08:30:55.000Z')}\n`);
    equal(log.tunnels, 1);
});

test('state: starting, connecting, on, reconnecting, stopping, failed, off', () => {
    const log = new NoticeLog();
    equal(tunnelState({alive: false, log, action: 'start'}), 'starting');
    equal(tunnelState({alive: true, log, action: null}), 'starting');
    log.feed(`${notice('ListeningHttpProxyPort', {port: 8081}, '2026-10-20T08:30:52.460Z')}\n`);
    equal(tunnelState({alive: true, log, action: null}), 'connecting');
    log.feed(`${notice('Tunnels', {count: 1}, '2026-10-20T08:30:55.000Z')}\n`);
    equal(tunnelState({alive: true, log, action: null}), 'on');
    log.feed(`${notice('Tunnels', {count: 0}, '2026-10-20T09:00:00.000Z')}\n`);
    equal(tunnelState({alive: true, log, action: null}), 'reconnecting');
    equal(tunnelState({alive: true, log, action: 'stop'}), 'stopping');
    equal(tunnelState({alive: false, log, action: null, failure: {kind: 'crash'}}), 'failed');
    equal(tunnelState({alive: false, log, action: null, failure: null}), 'off');
});

test('regions read in either language, with a flag', () => {
    equal(ru.region('NO'), 'Норвегия');
    equal(en.region('NO'), 'Norway');
    equal(ru.region('XX'), 'XX');
    equal(flagEmoji('NO'), '\u{1F1F3}\u{1F1F4}');
    equal(flagEmoji('nope'), '');
    equal(flagEmoji(null), '');
});

test('proxy settings in the environment point at the tunnel', () => {
    const env = ['HOME=/home/u', 'HTTPS_PROXY=http://127.0.0.1:8081', 'all_proxy=socks5://localhost:1081',
        'NO_PROXY=localhost,127.0.0.1', 'http_proxy=http://proxy.example:3128', ''].join('\0');
    deepEqual([...proxyPorts(env)].sort(), [1081, 8081]);
    deepEqual([...proxyPorts('PATH=/bin\0')], []);
    deepEqual([...proxyPorts('HTTP_PROXY=127.0.0.1:8081\0')], [8081]);
    deepEqual([...proxyPorts('HTTP_PROXY=http://user:pw@127.0.0.1:8081/\0')], [8081]);
});

// What `ss -tinpH state established '( dport = :8081 or dport = :1081 )'` prints.
const SS = `0      0      127.0.0.1:55772 127.0.0.1:8081 users:(("claude",pid=4242,fd=15))
\t cubic wscale:10,10 rto:202 bytes_sent:477859 bytes_retrans:33571 bytes_acked:444289 bytes_received:168891 segs_out:474
0      0      127.0.0.1:48700 127.0.0.1:1081 users:(("firefox",pid=5151,fd=59))
\t cubic wscale:10,10 rto:202 bytes_sent:5463 bytes_acked:5464 bytes_received:12026 segs_out:20
0      0      [::ffff:127.0.0.1]:40000 [::ffff:127.0.0.1]:8081 users:(("curl",pid=6000,fd=3))
\t cubic bytes_acked:100 bytes_received:2000
0      0      127.0.0.1:41000 127.0.0.1:9999 users:(("other",pid=7000,fd=3))
\t cubic bytes_acked:1 bytes_received:1
`;

test('sockets to the tunnel, with who holds them and how much went through', () => {
    const s = parseSockets(SS, [8081, 1081]);
    equal(s.length, 3);
    deepEqual(s[0], {key: '127.0.0.1:55772>127.0.0.1:8081', port: 8081, pid: 4242, comm: 'claude', rx: 168891, tx: 444289});
    equal(s[1].comm, 'firefox');
    equal(s[1].port, 1081);
    equal(s[2].pid, 6000);
    equal(s[2].rx, 2000);
});

test('the meter turns byte counts into rates, new sockets included', () => {
    const m = new Meter();
    const a = [{key: 'a', pid: 1, rx: 1000, tx: 100}];
    equal(m.sample(a, 10), null);
    const b = [{key: 'a', pid: 1, rx: 3000, tx: 300}, {key: 'b', pid: 2, rx: 500, tx: 0}];
    const r = m.sample(b, 12);
    equal(r.down, (2000 + 500) / 2);
    equal(r.up, 100);
    equal(r.byPid.get(1).down, 1000);
    equal(r.byPid.get(2).down, 250);
    // a counter that went backwards is a new socket on an old address
    const c = m.sample([{key: 'a', pid: 1, rx: 10, tx: 0}], 13);
    equal(c.down, 0);
});

test('a program and its children are one program', () => {
    const procs = new Map([
        [10, {ppid: 1, comm: 'zsh'}],
        [11, {ppid: 10, comm: 'claude'}],
        [12, {ppid: 11, comm: 'zsh'}],
        [13, {ppid: 12, comm: 'node'}],
        [20, {ppid: 10, comm: 'codex'}],
    ]);
    deepEqual(roots([11, 12, 13, 20], procs).sort(), [11, 20]);
    deepEqual(roots([13], procs), [13]);
});

test('names are joined the Russian way and the English way', () => {
    equal(ru.join([]), '');
    equal(ru.join(['Claude Code']), 'Claude Code');
    equal(ru.join(['Claude Code', 'Codex']), 'Claude Code и Codex');
    equal(ru.join(['Claude Code', 'Codex', 'Firefox']), 'Claude Code, Codex и Firefox');
    equal(en.join(['Claude Code', 'Codex', 'Firefox']), 'Claude Code, Codex and Firefox');
});

test('busy ports: loopback and wildcard listeners, not other addresses', () => {
    const tcp = `  sl  local_address rem_address   st tx_queue rx_queue
   0: 0100007F:1F91 00000000:0000 0A 00000000:00000000
   1: 00000000:0439 00000000:0000 0A 00000000:00000000
   2: 0501A8C0:1F92 00000000:0000 0A 00000000:00000000
   3: 0100007F:D9B4 0100007F:1F91 01 00000000:00000000`;
    deepEqual([...listeningPorts(tcp)].sort(), [1081, 8081]);
    const tcp6 = `  sl  local_address                         remote_address
   0: 00000000000000000000000000000000:1F93 00000000000000000000000000000000:0000 0A
   1: 0000000000000000FFFF00000100007F:1F94 00000000000000000000000000000000:0000 0A
   2: 00000000000000000000000001000000:1F95 00000000000000000000000000000000:0000 0A`;
    deepEqual([...listeningPorts(tcp6)].sort(), [8083, 8084]);
});

test('words: durations, clocks and rates', () => {
    equal(ru.duration(40), '40 с');
    equal(ru.duration(45 * 60), '45 мин');
    equal(ru.duration(3 * 3600 + 12 * 60), '3 ч 12 мин');
    equal(ru.duration(2 * 86400 + 3 * 3600 + 5), '2 д 3 ч');
    equal(en.duration(3 * 3600 + 12 * 60), '3 h 12 min');
    equal(formatClock(7), '0:07');
    equal(formatClock(3723), '1:02:03');
    equal(ru.rate(0), '0 Б/с');
    equal(ru.rate(12 * 1024), '12 КБ/с');
    equal(ru.rate(1.4 * 1024 * 1024), '1,4 МБ/с');
    equal(en.rate(1.4 * 1024 * 1024), '1.4 MB/s');
    equal(ru.ago(30), 'только что');
    equal(en.ago(5 * 60), '5 min ago');
});

// A process that can be told to die, on a fake clock.
function fakeProcess({diesOn = 'TERM', after = 120} = {}) {
    let clock = 0, deadAt = Infinity;
    const signals = [];
    return {
        signals,
        alive: () => clock < deadAt,
        signal: async sig => {
            signals.push(sig);
            if (sig === 'KILL' || sig === diesOn)
                deadAt = Math.min(deadAt, clock + (sig === 'KILL' ? 10 : after));
        },
        sleep: async ms => {
            clock += ms;
        },
        now: () => clock,
    };
}

test('stopping asks politely and waits for the goodbye', async () => {
    const p = fakeProcess({after: 120});
    const r = await stopProcess(p);
    equal(r.how, 'term');
    deepEqual(p.signals, ['TERM']);
    assert(r.ms >= 120 && r.ms < 300, `took ${r.ms} ms`);
});

test('a process that ignores SIGTERM is killed after the grace period', async () => {
    const p = fakeProcess({diesOn: 'never'});
    const r = await stopProcess(p, {grace: 3000});
    equal(r.how, 'kill');
    deepEqual(p.signals, ['TERM', 'KILL']);
    assert(r.ms >= 3000, `took ${r.ms} ms`);
});

test('a process that is already gone is not signalled', async () => {
    const p = fakeProcess();
    await p.signal('KILL');
    p.signals.length = 0;
    await p.sleep(100);
    const r = await stopProcess(p);
    equal(r.how, 'gone');
    deepEqual(p.signals, []);
});
