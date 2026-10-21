// Test and README media driver, see ../capture.sh. Runs inside an isolated
// headless gnome-shell next to psiphon-tunnel, whose $HOME is a throwaway
// one with its own ~/psiphon, and takes screenshots.
//   PT_MEDIA_MODE=smoke  a real Psiphon copy on test ports: start, users, the
//                        sheet, a stop that waits, a crash, a disable, a busy port
//   PT_MEDIA_MODE=media  the fake Psiphon and made-up users, for the README
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {findPsiphon, stillRunning} from '../psiphon-tunnel@terentiy/psiphon.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');
const OUT = GLib.getenv('PT_MEDIA_OUT');
const MODE = GLib.getenv('PT_MEDIA_MODE') ?? 'smoke';
const UUID = 'psiphon-tunnel@terentiy';
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));
const log = m => console.log(`[pt-media] ${m}`);
const now = () => GLib.get_monotonic_time() / 1000;
const meta = {checks: {}};
const TALL = 1500;      // taller than the popup ever gets, at 2x

function check(name, ok, detail = '') {
    meta.checks[name] = !!ok;
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

function hideBehind() {
    global.window_group.hide();
    Main.layoutManager._backgroundGroup.hide();
}

async function shot(name, [x, y, w, h]) {
    hideBehind();
    const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    await new Shell.Screenshot().screenshot_area(Math.round(x), Math.round(y), Math.round(w), Math.round(h), stream);
    stream.close(null);
}

function rectOf(actor, pad = 0) {
    const r = actor.get_transformed_extents();
    return [r.origin.x - pad, r.origin.y - pad, r.size.width + 2 * pad, r.size.height + 2 * pad];
}

async function until(fn, ms, step = 100) {
    const t0 = now();
    while (!fn()) {
        if (now() - t0 > ms)
            return false;
        await sleep(step);
    }
    return true;
}

function notifications() {
    return Main.messageTray.getSources().flatMap(s => s.notifications.map(n => n.title));
}

// A process that looks like Claude Code to the extension: named claude, told
// to use the tunnel by its environment.
function fakeClaude(port) {
    const bin = GLib.build_filenamev([GLib.get_home_dir(), 'bin', 'claude']);
    GLib.mkdir_with_parents(GLib.path_get_dirname(bin), 0o755);
    Gio.File.new_for_path('/bin/sleep').copy(Gio.File.new_for_path(bin), Gio.FileCopyFlags.OVERWRITE, null, null);
    GLib.chmod(bin, 0o755);
    const l = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE});
    l.setenv('HTTPS_PROXY', `http://127.0.0.1:${port}`, true);
    return l.spawnv([bin, '600']);
}

// Disabling psiphon-tunnel makes the Shell disable and re-enable every
// extension enabled after it, this one too: run once.
let started = false;

export default class Media extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        this._run().catch(e => {
            log(`FAILED ${e}\n${e.stack}`);
            global.context.terminate();
        });
    }

    disable() {}

    async _run() {
        await sleep(3000);
        Main.overview.hide();
        await sleep(1000);
        hideBehind();
        const ext = Main.extensionManager.lookup(UUID);
        log(`state=${ext.state} error=${ext.error ?? ''}`);
        try {
            if (MODE === 'smoke')
                await this._smoke(ext);
            else
                await this._media(ext);
        } finally {
            // nothing of ours may outlive the test shell
            const me = ext.stateObj;
            if (me?._psiphon && findPsiphon(me._psiphon.paths).length)
                await me._psiphon.stop({grace: 3000});
            GLib.file_set_contents(`${OUT}/meta.json`, JSON.stringify(meta, null, 1));
            log('done');
            await sleep(300);
            global.context.terminate();
        }
    }

    async _smoke(ext) {
        let me = ext.stateObj;
        const ind = () => Main.panel.statusArea[UUID];
        const box = () => rectOf(ind().menu.box);
        const ps = () => me._psiphon;
        const port = 18081;
        log(`paths: ${JSON.stringify(ps().paths)}`);
        check('starts off', ps().state === 'off', ps().state);

        // a timeline of states, as the panel sees them
        const seen = [];
        const watch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const s = ext.stateObj?._psiphon?.state;
            if (s && s !== seen[seen.length - 1]?.[0])
                seen.push([s, Math.round(now())]);
            return GLib.SOURCE_CONTINUE;
        });

        await shot('panel_off', rectOf(ind(), 10));
        ind().menu.open();
        await sleep(1500);
        await shot('card_off', box());

        // Включить
        let t0 = now();
        me._card._main.emit('clicked', 1);
        const up = await until(() => ps().state === 'on', 90000);
        check('connects', up, `${Math.round((now() - t0) / 100) / 10} s, region ${ps().log.region}`);
        const pid = ps().proc?.pid;
        const pidfile = new TextDecoder().decode(GLib.file_get_contents(ps().paths.pidfile)[1]).trim();
        check('pid file like psi-on', pidfile === String(pid), `${pidfile} vs ${pid}`);
        // The isolated runtime dir hides the user systemd, so here it is setsid
        // alone; tests/process.test.js checks the scope against the real one.
        const cat = file => new TextDecoder().decode(GLib.file_get_contents(file)[1]).trim();
        const sid = cat(`/proc/${pid}/stat`).split(') ')[1].split(' ')[3];
        check('own session', sid === String(pid), `sid ${sid}`);
        log(`cgroup: ${cat(`/proc/${pid}/cgroup`)} (Shell: ${cat('/proc/self/cgroup')})`);
        await sleep(2500);
        await shot('card_on_empty', box());

        // somebody uses it
        const claude = fakeClaude(port);
        const curl = Gio.Subprocess.new(['curl', '-s', '-o', '/dev/null', '-x', `http://127.0.0.1:${port}`,
            '--limit-rate', '400k', '--max-time', '40',
            'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb'],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        // Psiphon's server may take a moment to reach the download, and the
        // environments are scanned every few seconds
        // A real server's speed comes in bursts: count the peak, not one look.
        let peak = 0;
        await until(() => {
            peak = Math.max(peak, me._users.rates?.down ?? 0);
            return peak > 10000 && me._latency && me._users.list().some(u => u.env);
        }, 20000);
        await sleep(1200);
        const m = me._model(Date.now() / 1000);
        log(`latency=${JSON.stringify(m.latency)} rates=${JSON.stringify(m.rates && {down: m.rates.down, up: m.rates.up})}`);
        log(`users=${JSON.stringify(m.users.map(u => ({name: u.name, env: u.env, live: u.live, down: Math.round(u.down)})))}`);
        check('latency measured', m.latency && !m.latency.error, JSON.stringify(m.latency));
        check('sees Claude Code by env', m.users.some(u => u.name === 'Claude Code' && u.env));
        check('sees curl by its socket', m.users.some(u => u.name === 'curl' && u.live));
        check('traffic counted', peak > 10000, `peak ${Math.round(peak)} B/s`);
        await shot('card_on', box());

        // Выключить: two programs lean on it, so ask first
        me._card._main.emit('clicked', 1);
        await until(() => me._card._sheet.visible, 5000);
        check('asks before cutting them off', me._card._sheet.visible, me._card._sheetText.text);
        await sleep(400);
        await shot('card_sheet', box());

        // Когда они закроются
        me._card._act('stop-later');
        await sleep(800);
        check('waits for them', !!me._state.pending && ps().state === 'on', JSON.stringify(me._state.pending?.names));
        await shot('card_waiting', box());
        ind().menu.close();
        await sleep(1200);
        await shot('panel_waiting', rectOf(ind(), 10));

        // a Shell restart (or the lock screen) in the middle of waiting keeps the promise
        const proc = {...ps().proc};
        await Main.extensionManager._callExtensionDisable(UUID);
        await sleep(1500);
        check('disable leaves Psiphon running', stillRunning(proc));
        await Main.extensionManager._callExtensionEnable(UUID);
        me = ext.stateObj;
        check('adopts it after enable', ps().proc?.pid === pid, `${ps().proc?.pid} vs ${pid}`);
        check('still waiting after enable', !!me._state.pending, JSON.stringify(me._state.pending?.wait?.map(w => w.name)));

        // they leave: the tunnel closes by itself, politely
        claude.force_exit();
        await sleep(1500);
        check('still open while curl runs', ps().state === 'on');
        curl.force_exit();
        t0 = now();
        const closed = await until(() => ps().state === 'off', 20000);
        check('closes once they are gone', closed, `${Math.round(now() - t0)} ms`);
        check('closed with SIGTERM', me._lastStop?.how === 'term', JSON.stringify(me._lastStop));
        check('Psiphon said goodbye', ps().log.exited);
        check('pid file removed', !GLib.file_test(ps().paths.pidfile, GLib.FileTest.EXISTS));
        check('told about it', notifications().includes('Туннель закрыт'), JSON.stringify(notifications()));
        ind().menu.open();
        await sleep(1500);
        await shot('card_closed', box());
        ind().menu.close();

        // a crash
        me._onAction('start');
        await until(() => ps().state === 'on', 90000);
        const victim = ps().proc.pid;
        GLib.spawn_command_line_sync(`kill -KILL ${victim}`);
        const failed = await until(() => ps().state === 'failed', 6000);
        check('notices a crash', failed && ps().failure?.kind === 'crash', JSON.stringify(ps().failure));
        await sleep(300);
        check('says so', notifications().includes('Psiphon упал'), JSON.stringify(notifications()));
        await shot('panel_failed', rectOf(ind(), 10));
        ind().menu.open();
        await sleep(1500);
        await shot('card_failed', box());

        // Запустить снова, then a stop nobody depends on: no questions
        me._card._main.emit('clicked', 1);
        await until(() => ps().state === 'on', 90000);
        me._card._main.emit('clicked', 1);
        const quick = await until(() => ps().state === 'off', 8000);
        check('stops at once when nobody uses it', quick && !me._card._sheet.visible, JSON.stringify(me._lastStop));
        await sleep(1200);
        await shot('card_stopped', box());
        ind().menu.close();

        // someone else holds the port
        const blocker = new Gio.SocketService();
        blocker.add_inet_port(port, null);
        me._onAction('start');
        await until(() => ps().state === 'failed', 5000);
        check('busy port caught', ps().failure?.kind === 'port' && ps().failure.port === port, JSON.stringify(ps().failure));
        ind().menu.open();
        await sleep(1500);
        await shot('card_port', box());
        ind().menu.close();
        blocker.stop();
        blocker.close();

        GLib.source_remove(watch);
        log(`timeline: ${seen.map(([s, t]) => `${s}@${t - seen[0][1]}`).join(' ')}`);
        check('nothing left running', findPsiphon(ps().paths).length === 0);
    }

    // Made-up data only: the card is fed models, the panel glyph states.
    async _media(ext) {
        const me = ext.stateObj;
        const ind = Main.panel.statusArea[UUID];
        const card = me._card;
        me._tick = () => {};
        me._refresh = () => {};
        const box = () => rectOf(ind.menu.box);
        const now = Date.now() / 1000;
        const term = 'utilities-terminal-symbolic';
        const firefox = new Gio.ThemedIcon({name: 'firefox'});
        const waiting = [
            {name: 'Claude Code', iconName: term, env: true, count: 2, down: 0, up: 0},
            {name: 'Codex', iconName: term, env: true, count: 1, down: 0, up: 0},
        ];
        const users = [
            {name: 'Firefox', gicon: firefox, live: true, count: 1, down: 1.31e6, up: 52e3},
            {name: 'Claude Code', iconName: term, env: true, live: true, count: 2, down: 96e3, up: 31e3},
            {name: 'Codex', iconName: term, env: true, last: now - 4 * 60, count: 1, down: 0, up: 0},
        ];
        const base = {
            now, home: '/home/user', state: 'on', region: 'NL', auto: true,
            uptime: 2 * 3600 + 14 * 60, ran: 5 * 3600 + 3 * 60, elapsed: 0, drops: 1, regionChanges: 1,
            ports: {http: 8081, socks: 1081}, extra: 0, failure: null, lastStop: null,
            latency: {ms: 184}, rates: {down: 1.42e6, up: 86e3}, users, pending: null,
        };
        const SCENES = {
            off: {...base, state: 'off', region: 'NL', users: waiting, rates: null, latency: null,
                lastStop: {how: 'term', ms: 120, grace: 5000, at: now - 20}},
            connecting: {...base, state: 'connecting', region: null, elapsed: 3, drops: 0, regionChanges: 0,
                ran: 3, uptime: 0, latency: null, rates: null, users: waiting},
            on: base,
            waiting: {...base, pending: {names: ['Firefox', 'Claude Code', 'Codex']}},
            failed: {...base, state: 'failed', failure: {kind: 'crash'}, users: waiting, rates: null, latency: null},
        };
        const NAMES = ['Firefox', 'Claude Code', 'Codex'];
        const show = (k, extra = {}) => {
            const m = {...SCENES[k], ...extra};
            card.update(m);
            ind.glyph.set({state: m.state, pending: !!m.pending});
        };

        for (const k of ['off', 'connecting', 'on', 'waiting', 'failed']) {
            show(k);
            await sleep(k === 'connecting' ? 1100 : 2000);
            await shot(`panel_${k}`, rectOf(ind, 10));
        }

        for (const k of ['on', 'sheet', 'waiting', 'off']) {
            card.confirm(null);
            show(k === 'sheet' ? 'on' : k);
            await sleep(300);
            ind.menu.open();
            if (k === 'sheet')
                card.confirm(NAMES);
            await sleep(2600);
            for (let i = 0; i < 6; i++) {
                await shot(`card_${k}_${i}`, box());
                await sleep(500);
            }
            meta[`card_${k}`] = box();
            ind.menu.close();
            await sleep(900);
        }

        // the animation: Psiphon finds a server, then a polite stop
        card.confirm(null);
        show('connecting');
        await sleep(1000);
        const frames = [];
        const t0 = now_();
        ind.menu.open();
        let elapsed = 3;
        const plan = [
            [1000, () => show('connecting', {elapsed: ++elapsed})],
            [2000, () => show('connecting', {elapsed: ++elapsed})],
            [2700, () => show('on', {uptime: 2, ran: 6, drops: 0, regionChanges: 0, latency: null})],
            [3700, () => show('on', {uptime: 3, ran: 7, drops: 0, regionChanges: 0, latency: {ms: 191}})],
            [4700, () => show('on', {uptime: 4, ran: 8, drops: 0, regionChanges: 0, latency: {ms: 191}})],
            [5900, () => card.confirm(NAMES)],
            [7900, () => show('waiting', {uptime: 7, ran: 11, drops: 0, regionChanges: 0, latency: {ms: 191}})],
        ];
        while (now_() - t0 < 10200) {
            const t = now_() - t0;
            while (plan.length && plan[0][0] <= t)
                plan.shift()[1]();
            // The box is measured before the frame that the screenshot waits
            // for, so it can be a layout behind: shoot tall, and keep the
            // height the box had in the frame that was shot.
            const name = `gif_${String(frames.length).padStart(4, '0')}`;
            const [x, y, w, before] = box();
            await shot(name, [x, y, w, TALL]);
            frames.push([name, Math.round(t), Math.round(box()[3]), Math.round(before)]);
        }
        meta.frames = frames;
        log(`gif: ${frames.length} frames in ${Math.round(now_() - t0)} ms`);
        ind.menu.close();
        await sleep(500);
    }
}

const now_ = now;

