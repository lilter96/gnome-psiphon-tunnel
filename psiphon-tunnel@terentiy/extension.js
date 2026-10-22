import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Card} from './card.js';
import {T, setLanguage} from './lang.js';
import {SystemProxy, proxyPlan} from './proxy.js';
import {Psiphon, Users, configPorts, defaultPaths, probe, procStat, writeRegion} from './psiphon.js';
import {DEFAULT_REGIONS, failureOf} from './tunnel.js';
import {PanelGlyph} from './ui.js';

// Seconds between looks. The popup open wants everything fresh; closed, the
// extension only needs to notice a crash and who leans on the tunnel.
const POLL = 2;             // is Psiphon still there
const RESCAN = 10;          // did someone start it from a terminal
const SAMPLE = {open: 1, closed: 10, waiting: 3};     // sockets: who is connected, how fast
const ENV = {open: 3, closed: 30, waiting: 3};        // environments: who is told to use it
const PROBE_EVERY = 30;
const GRACE = 5000;         // ms Psiphon gets to say goodbye before SIGKILL

const CLI = new Set(['Claude Code', 'Codex', 'curl', 'wget', 'git']);
const wallClock = () => Date.now() / 1000;
const RUNNING = new Set(['starting', 'connecting', 'on', 'reconnecting']);

function bootId() {
    try {
        return new TextDecoder().decode(GLib.file_get_contents('/proc/sys/kernel/random/boot_id')[1]).trim();
    } catch {
        return null;
    }
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Psiphon');
        this.menu.actor.add_style_class_name('pt-menu');
        this.glyph = new PanelGlyph();
        this.add_child(this.glyph);
    }

    appear() {
        this.opacity = 0;
        this.ease({opacity: 255, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.glyph.pop();
    }
});

// Settings when the schema was not compiled (a copy without install.sh):
// the defaults, kept for this session only.
function looseSettings() {
    const values = {'language': '', 'system-proxy': false};
    return {
        get_string: k => values[k],
        get_boolean: k => values[k],
        set_boolean: (k, v) => {
            values[k] = v;
        },
        connect: () => 0,
        disconnect: () => {},
    };
}

export default class PsiphonTunnelExtension extends Extension {
    enable() {
        const stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'psiphon-tunnel']);
        this._statePath = GLib.build_filenamev([stateDir, 'state.json']);
        const saved = this._read(this._statePath);
        this._state = {
            pending: saved?.pending ?? null,    // {pid, start, since, names}: stop once they are gone
            seen: saved?.seen ?? null,          // {pid, start, boot}: the Psiphon we last saw running
            regions: saved?.regions ?? null,    // the countries Psiphon offered last time
            proxy: saved?.proxy ?? null,        // what we set the system proxy to, and what it was
        };
        try {
            this._settings = this.getSettings();
        } catch (e) {
            console.warn(`[${this.uuid}] ${e.message}: run install.sh to compile the settings schema`);
            this._settings = looseSettings();
        }
        setLanguage(this._settings.get_string('language'));
        this._settingsIds = [
            this._settings.connect('changed::language', () => {
                setLanguage(this._settings.get_string('language'));
                this._idleState = null;
                this._refresh();
            }),
            this._settings.connect('changed::system-proxy', () => {
                this._syncProxy();
                this._refresh();
            }),
        ];
        this._systemProxy = new SystemProxy();
        this._switching = null;     // the country Psiphon is restarting for, '' for the fastest
        this._home = GLib.get_home_dir();
        this._menuOpen = false;
        this._t = 0;
        this._due = {sample: 0, env: 0, probe: 0, rescan: 0};
        this._sampling = false;
        this._latency = null;
        this._lastStop = null;
        this._probeCancel = null;
        this._icons = new Map();

        const self = new Gio.Credentials().get_unix_pid();
        // the proxy follows Psiphon at once, not on the next tick
        this._psiphon = new Psiphon(defaultPaths(this._home), () => {
            this._syncProxy();
            this._refresh();
        });
        this._users = new Users({
            self,
            exclude: () => this._psiphon ? [this._psiphon.proc?.pid, ...this._psiphon.extra.map(p => p.pid)] : [],
        });
        this._adopt();

        this._indicator = new Indicator();
        this._card = new Card();
        this._card.onAction = (what, arg) => this._onAction(what, arg);
        const section = new PopupMenu.PopupMenuSection();
        section.box.add_child(this._card);
        this._indicator.menu.addMenuItem(section);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.appear();
        this._menuId = this._indicator.menu.connect('open-state-changed', (_m, open) => {
            this._menuOpen = open;
            if (open) {
                this._due.sample = this._due.env = this._due.probe = 0;
                this._tick(true);
                this._card.play();
            } else {
                this._card.pause();
                this._probeCancel?.cancel();
            }
        });

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._tick(true);
    }

    // Never stops Psiphon: the lock screen and a Shell restart come through
    // here, and the tunnel must outlive both. The system proxy stays through
    // the lock screen too, but not when someone turns the extension off:
    // nobody would put it back then.
    disable() {
        GLib.source_remove(this._tickId);
        this._probeCancel?.cancel();
        if (this._state.proxy && !Main.sessionMode.isLocked)
            this._restoreProxy();
        this._save();
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._indicator.menu.disconnect(this._menuId);
        this._psiphon.destroy();
        this._indicator.destroy();
        this._source?.destroy();
        this._indicator = this._card = this._psiphon = this._users = this._source = null;
        this._state = this._icons = this._settings = this._systemProxy = null;
    }

    // A Psiphon that died while we were away (behind the lock screen) died all
    // the same: say so, unless it said goodbye.
    _adopt() {
        const ps = this._psiphon, seen = this._state.seen;
        if (ps.proc || !seen || seen.boot !== bootId())
            return;
        const failure = failureOf(ps.log);
        if (failure) {
            ps.failure = failure;
            ps.ended = {pid: seen.pid, failure};
        }
        this._state.seen = null;
        this._save();
    }

    // --- the clock -------------------------------------------------------------

    _tick(now = false) {
        if (!this._psiphon)
            return;
        const t = ++this._t;
        const ps = this._psiphon;
        if (now || t % POLL === 0) {
            const rescan = now || t >= this._due.rescan;
            if (rescan)
                this._due.rescan = t + RESCAN;
            ps.poll(rescan);
        }
        this._remember();
        if (ps.ended?.failure && ps.ended !== this._notifiedEnd)
            this._onCrash(ps.ended);
        this._keepRegions();
        this._syncProxy();

        const mode = this._menuOpen ? 'open' : this._state.pending ? 'waiting' : 'closed';
        const ports = this._ports();
        const running = !!ps.proc;
        if (ports.length && (running || this._menuOpen) && t >= this._due.env) {
            this._due.env = t + ENV[mode];
            this._users.scanEnv(ports);
        }
        if (ports.length && running && t >= this._due.sample && !this._sampling) {
            this._due.sample = t + SAMPLE[mode];
            this._sample(ports);
        }
        if (this._menuOpen && ps.state === 'on' && t >= this._due.probe) {
            this._due.probe = t + PROBE_EVERY;
            this._probe();
        }
        if (this._state.pending)
            this._checkPending();
        this._refresh();
    }

    _ports() {
        const {http, socks} = this._psiphon.ports;
        return [http, socks].filter(p => p);
    }

    // The countries Psiphon offers, kept for when it is not running.
    _keepRegions() {
        const regions = this._psiphon.log.regions;
        if (regions.length && regions.join() !== this._state.regions?.join()) {
            this._state.regions = [...regions];
            this._save();
        }
    }

    // Keep the running Psiphon on disk, to tell a crash behind the lock screen.
    _remember() {
        const proc = this._psiphon.proc;
        const s = this._state.seen;
        if (proc && (!s || s.pid !== proc.pid || s.start !== proc.start)) {
            this._state.seen = {pid: proc.pid, start: proc.start, boot: bootId()};
            this._save();
        } else if (!proc && s && !this._psiphon.action) {
            this._state.seen = null;
            this._save();
        }
    }

    async _sample(ports) {
        this._sampling = true;
        try {
            await this._users.sample(ports);
        } catch (e) {
            console.warn(`[${this.uuid}] ss: ${e.message}`);
        } finally {
            this._sampling = false;
        }
        if (this._menuOpen)
            this._refresh();
    }

    async _probe() {
        const port = this._psiphon.ports.http;
        if (!port)
            return;
        this._probeCancel?.cancel();
        const cancel = this._probeCancel = new Gio.Cancellable();
        try {
            const ms = await probe(port, cancel);
            this._latency = {ms, at: wallClock()};
        } catch (e) {
            if (cancel.is_cancelled() || !this._psiphon)
                return;
            this._latency = {error: e.message, at: wallClock()};
        }
        this._refresh();
    }

    // --- what the buttons do -------------------------------------------------------

    _onAction(what, arg) {
        switch (what) {
        case 'start':
            this._start();
            break;
        case 'stop':
            this._askStop();
            break;
        case 'stop-now':
            this._stop();
            break;
        case 'stop-later':
            this._stopLater();
            break;
        case 'cancel-later':
            this._setPending(null);
            break;
        case 'region':
            this._setRegion(arg);
            break;
        case 'proxy':
            this._settings.set_boolean('system-proxy', !this._settings.get_boolean('system-proxy'));
            this._syncProxy();
            this._refresh();
            break;
        }
    }

    // A new country goes to client.conf; a running Psiphon reads it when it
    // starts, so it is restarted. The programs on the tunnel lose it for the
    // seconds that takes, and the system proxy stays put through it.
    async _setRegion(code) {
        const ps = this._psiphon;
        if (this._switching !== null || ps.action)
            return;
        try {
            if (!writeRegion(ps.paths.conf, code))
                return;
        } catch (e) {
            this._notify(T.notify.countryTitle, T.notify.countryBody(e.message));
            return;
        }
        if (!ps.proc) {
            this._refresh();
            return;
        }
        this._switching = code;
        this._setPending(null);
        this._probeCancel?.cancel();
        try {
            await ps.stop({grace: GRACE});
            if (!this._psiphon)
                return;
            this._latency = null;
            this._lastStop = null;
            this._users.meter.reset();
            await ps.start();
        } finally {
            if (this._psiphon) {
                this._switching = null;
                this._due.probe = this._t + 1;
                this._tick(true);
            }
        }
    }

    // --- the system proxy ----------------------------------------------------------

    _syncProxy() {
        const ps = this._psiphon;
        if (!ps)
            return;
        const plan = proxyPlan({
            want: this._settings.get_boolean('system-proxy'),
            state: ps.state,
            ports: ps.ports,
            applied: this._state.proxy,
            holding: this._switching !== null,
        });
        if (plan === 'apply') {
            try {
                this._state.proxy = this._systemProxy.apply(ps.ports, this._state.proxy);
            } catch (e) {
                console.error(`[${this.uuid}] system proxy: ${e.message}`);
            }
            this._save();
        } else if (plan === 'restore') {
            this._restoreProxy();
            this._save();
        }
    }

    _restoreProxy() {
        try {
            this._systemProxy.restore(this._state.proxy);
        } catch (e) {
            console.error(`[${this.uuid}] system proxy: ${e.message}`);
        }
        this._state.proxy = null;
    }

    async _start() {
        this._setPending(null);
        this._latency = null;
        this._lastStop = null;
        this._users.meter.reset();
        await this._psiphon.start();
        if (!this._psiphon)
            return;
        this._due.probe = this._t + 1;
        this._tick(true);
    }

    // Programs that lose their connection if the tunnel closes now.
    _dependents() {
        return this._users.list().map(u => this._dress(u));
    }

    // The same, as processes to wait for: {pid, start, name}. They outlive a
    // restart of the Shell, which forgets who it saw connected.
    _waitFor(list) {
        return list.flatMap(u => u.pids.map(pid => ({pid, start: procStat(pid)?.start, name: u.name})))
            .filter(w => w.start !== undefined);
    }

    async _askStop() {
        const ports = this._ports();
        if (ports.length) {
            this._users.scanEnv(ports);
            await this._users.sample(ports).catch(() => null);
        }
        if (!this._psiphon)
            return;
        const names = this._dependents().map(u => u.name);
        if (names.length)
            this._card.confirm(names);
        else
            this._stop();
    }

    async _stop() {
        this._setPending(null);
        this._probeCancel?.cancel();
        const r = await this._psiphon.stop({grace: GRACE});
        if (!this._psiphon)
            return;
        this._lastStop = r ? {...r, grace: GRACE, at: wallClock()} : null;
        this._latency = null;
        this._users.meter.reset();
        this._state.seen = null;
        this._save();
        this._refresh();
        return r;
    }

    _stopLater() {
        const proc = this._psiphon.proc;
        if (!proc)
            return;
        const deps = this._dependents();
        this._setPending({pid: proc.pid, start: proc.start, since: wallClock(),
            names: deps.map(u => u.name), wait: this._waitFor(deps)});
    }

    _setPending(p) {
        this._state.pending = p;
        this._save();
        this._refresh();
    }

    // Waiting for the programs to go: once they have, close the tunnel.
    async _checkPending() {
        const p = this._state.pending, proc = this._psiphon.proc;
        if (!proc || proc.pid !== p.pid || proc.start !== p.start) {
            // closed or restarted by someone else: nothing to wait for
            this._setPending(null);
            return;
        }
        if (this._checking)
            return;
        this._checking = true;
        try {
            const deps = this._dependents();
            const alive = w => procStat(w.pid)?.start === w.start;
            const wait = [...(p.wait ?? []).filter(alive), ...this._waitFor(deps)]
                .filter((w, i, all) => all.findIndex(x => x.pid === w.pid) === i);
            const names = [...new Set(wait.map(w => w.name))];
            if (names.length) {
                if (names.join() !== p.names.join() || wait.length !== (p.wait ?? []).length) {
                    p.names = names;
                    p.wait = wait;
                    this._save();
                }
                return;
            }
            const was = p.names;
            const r = await this._stop();
            if (r && r.how !== 'stuck')
                this._notify(T.notify.closedTitle, was.length ? T.notify.closedBody(was) : T.notify.agreed);
        } finally {
            this._checking = false;
        }
    }

    _onCrash(ended) {
        this._notifiedEnd = ended;
        this._setPending(null);
        const f = ended.failure;
        const body = f.kind === 'port' ? T.notify.portBody(f.port) : T.notify.crashBody;
        this._notify(T.notify.crashTitle, body, {label: T.notify.again, fn: () => this._start()});
    }

    _notify(title, body, action = null) {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'Psiphon',
                icon: Gio.FileIcon.new(this.dir.get_child('icons').get_child('mole.png')),
            });
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const n = new MessageTray.Notification({
            source: this._source,
            title,
            body,
            urgency: MessageTray.Urgency.NORMAL,
        });
        if (action)
            n.addAction(action.label, () => this._psiphon && action.fn());
        this._source.addNotification(n);
    }

    // --- UI -------------------------------------------------------------------------

    // A name and an icon people know: the app's own for GUI programs, a
    // terminal for command-line ones.
    _dress(u) {
        let icon = this._icons.get(u.pid);
        if (icon === undefined) {
            icon = null;
            if (!CLI.has(u.name)) {
                const tracker = Shell.WindowTracker.get_default();
                let pid = u.pid;
                for (let i = 0; i < 6 && pid > 1; i++) {
                    const app = tracker.get_app_from_pid(pid);
                    if (app) {
                        icon = {gicon: app.get_icon(), name: app.get_name()};
                        break;
                    }
                    pid = procStat(pid)?.ppid ?? 0;
                }
            }
            this._icons.set(u.pid, icon);
            if (this._icons.size > 64)
                this._icons.delete(this._icons.keys().next().value);
        }
        return {
            ...u,
            name: icon && !CLI.has(u.name) && u.name === u.comm ? icon.name : u.name,
            gicon: icon?.gicon ?? null,
            iconName: CLI.has(u.name) ? 'utilities-terminal-symbolic' : null,
        };
    }

    _model(now) {
        const ps = this._psiphon, log = ps.log, state = ps.state;
        const started = ps.startedAt;
        let elapsed = 0;
        if (state === 'connecting' || state === 'starting')
            elapsed = now - (log.startAt ?? started ?? now);
        else if (state === 'reconnecting')
            elapsed = now - (log.downAt ?? now);
        const conf = configPorts(ps.paths.conf);
        return {
            now,
            home: this._home,
            bin: ps.paths.bin,
            installed: GLib.file_test(ps.paths.bin, GLib.FileTest.IS_EXECUTABLE),
            state,
            region: log.region,
            chosen: conf.readable ? conf.region ?? '' : null,
            regions: log.regions.length ? log.regions : this._state.regions ?? DEFAULT_REGIONS,
            switching: this._switching,
            proxy: {want: this._settings.get_boolean('system-proxy'), applied: !!this._state.proxy},
            uptime: log.upAt ? now - log.upAt : 0,
            ran: started ? now - started : 0,
            elapsed: Math.max(0, elapsed),
            drops: log.drops,
            regionChanges: log.regionChanges,
            ports: ps.ports,
            extra: ps.extra.length,
            failure: ps.failure,
            lastStop: this._lastStop,
            latency: this._latency,
            rates: ps.proc ? this._users.rates : null,
            users: this._users.list().map(u => this._dress(u)),
            pending: this._state.pending,
        };
    }

    _refresh() {
        if (!this._indicator)
            return;
        const ps = this._psiphon;
        const state = ps.state;
        const pending = !!this._state.pending && RUNNING.has(state);
        this._indicator.glyph.set({state, pending});
        const region = ps.log.region;
        this._indicator.accessible_name = {
            on: T.a11y.on(region && T.region(region)),
            off: T.a11y.off,
            failed: T.a11y.failed,
        }[state] ?? T.a11y.connecting;

        const now = wallClock();
        if (this._menuOpen) {
            this._card.update(this._model(now));
        } else if (state !== this._idleState || region !== this._idleRegion) {
            this._idleState = state;
            this._idleRegion = region;
            this._card.idle({state, region});
        }
    }

    // --- state ---------------------------------------------------------------------

    _read(path) {
        try {
            const [, bytes] = GLib.file_get_contents(path);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return null;
        }
    }

    _save() {
        if (!this._state)
            return;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._statePath), 0o755);
            GLib.file_set_contents(this._statePath, JSON.stringify({version: 1, ...this._state}));
        } catch (e) {
            console.error(`[${this.uuid}] cannot save state: ${e.message}`);
        }
    }
}
