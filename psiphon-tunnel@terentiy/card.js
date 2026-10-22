// The popup: the mole at its hole, what the tunnel is doing, one button to
// open or close it, four tiles, the programs that go through it, and two
// settings: the country and the system proxy. The country opens a list in
// place of the tiles.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {T} from './lang.js';
import {Mole} from './mole.js';
import {flagEmoji, formatClock} from './tunnel.js';
import {SceneView, animationsEnabled} from './ui.js';

const CENTER = Clutter.ActorAlign.CENTER;
const RUNNING = new Set(['starting', 'connecting', 'on', 'reconnecting']);
const MAX_ROWS = 5;
const STOP_NOTE = 10 * 60;      // how long "closed in 0.1 s" stays under the title
const CHIP_ROW = 40;            // px a row of countries takes, spacing included
// A column: `vertical` until GNOME 48 brought `orientation`; 51 dropped `vertical`.
const COLUMN = GObject.Object.find_property.call(St.BoxLayout, 'orientation')
    ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};
const PICKER_MAX = 296;         // px of countries before the list scrolls

// "🇩🇪 Germany"
const where = code => (code ? `${flagEmoji(code)} ${T.region(code)}`.trim() : '');

function wrap(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function button(style, onClick) {
    const b = new St.Button({style_class: style, can_focus: true, x_expand: true});
    b.connect('clicked', onClick);
    return b;
}

// A tile: a small caption, a value, one quiet line.
function makeTile() {
    const box = new St.BoxLayout({...COLUMN, style_class: 'pt-tile', x_expand: true});
    const label = new St.Label({style_class: 'pt-tile-label'});
    const value = new St.Label({style_class: 'pt-tile-value'});
    const sub = new St.Label({style_class: 'pt-tile-sub'});
    for (const a of [label, value, sub])
        box.add_child(a);
    const set = (l, v, s, tone = '') => {
        label.text = l;
        value.text = v;
        sub.text = s;
        value.style_class = `pt-tile-value ${tone ? `pt-tone-${tone}` : ''}`;
    };
    return {box, set};
}

function toggle(actor, cls, on) {
    if (on)
        actor.add_style_class_name(cls);
    else
        actor.remove_style_class_name(cls);
}

export const Card = GObject.registerClass(
class Card extends St.BoxLayout {
    _init() {
        super._init({...COLUMN, style_class: 'pt-card'});
        this.onAction = null;
        this.mole = new Mole({reducedMotion: !animationsEnabled()});
        this.scene = new SceneView(this.mole);
        this._model = null;
        this._confirm = null;           // names, while the "are you sure" sheet is up
        this._picking = false;          // the list of countries is open
        this._lang = null;
        this._chipsKey = null;

        this._title = new St.Label({style_class: 'pt-title', x_align: CENTER});
        this._subtitle = wrap(new St.Label({style_class: 'pt-subtitle', x_align: CENTER}));
        this._subtitle.clutter_text.line_alignment = Pango.Alignment.CENTER;

        this._main = button('pt-main', () => this._act(this._mainAction));

        // closing the tunnel under someone's feet: say who, offer to wait
        this._sheet = new St.BoxLayout({...COLUMN, style_class: 'pt-sheet', visible: false});
        this._sheetText = wrap(new St.Label({style_class: 'pt-sheet-text'}));
        this._sheetText.clutter_text.line_alignment = Pango.Alignment.CENTER;
        this._now = button('pt-sheet-btn pt-danger', () => this._act('stop-now'));
        this._later = button('pt-sheet-btn pt-accent', () => this._act('stop-later'));
        this._cancel = button('pt-sheet-btn', () => this._act('cancel'));
        for (const a of [this._sheetText, this._now, this._later, this._cancel])
            this._sheet.add_child(a);

        // waiting for them to finish
        this._wait = new St.BoxLayout({...COLUMN, style_class: 'pt-wait', visible: false});
        this._waitText = wrap(new St.Label({style_class: 'pt-wait-text'}));
        const waitRow = new St.BoxLayout({style_class: 'pt-wait-row'});
        waitRow.layout_manager.homogeneous = true;
        this._keep = button('pt-wait-btn', () => this._act('cancel-later'));
        this._waitNow = button('pt-wait-btn pt-danger', () => this._act('stop-now'));
        waitRow.add_child(this._keep);
        waitRow.add_child(this._waitNow);
        this._wait.add_child(this._waitText);
        this._wait.add_child(waitRow);

        this._tiles = [0, 1, 2, 3].map(() => makeTile());
        this._grid = new St.BoxLayout({...COLUMN, style_class: 'pt-tiles'});
        for (const pair of [this._tiles.slice(0, 2), this._tiles.slice(2)]) {
            const row = new St.BoxLayout({style_class: 'pt-tiles-row'});
            row.layout_manager.homogeneous = true;
            pair.forEach(t => row.add_child(t.box));
            this._grid.add_child(row);
        }

        this._users = new St.BoxLayout({...COLUMN, style_class: 'pt-users'});
        const head = new St.BoxLayout({style_class: 'pt-section-head'});
        this._usersTitle = new St.Label({style_class: 'pt-section-title', x_expand: true});
        this._usersRight = new St.Label({style_class: 'pt-section-right'});
        head.add_child(this._usersTitle);
        head.add_child(this._usersRight);
        this._rows = new St.BoxLayout({...COLUMN, style_class: 'pt-rows'});
        this._users.add_child(head);
        this._users.add_child(this._rows);

        this._buildGroup();
        this._buildPicker();

        this._footer = wrap(new St.Label({style_class: 'pt-footer', x_align: CENTER}));
        this._footer.clutter_text.line_alignment = Pango.Alignment.CENTER;

        for (const a of [this.scene, this._title, this._subtitle, this._main, this._sheet, this._wait,
            this._grid, this._users, this._group, this._picker, this._footer])
            this.add_child(a);
    }

    // Country and system proxy, two rows of one rounded box.
    _buildGroup() {
        this._group = new St.BoxLayout({...COLUMN, style_class: 'pt-group'});

        this._countryRow = button('pt-group-row', () => this._pick(true));
        const country = new St.BoxLayout({x_expand: true});
        this._countryLabel = new St.Label({style_class: 'pt-group-label', x_expand: true, y_align: CENTER});
        this._countryValue = new St.Label({style_class: 'pt-group-value', y_align: CENTER});
        this._countryValue.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        country.add_child(this._countryLabel);
        country.add_child(this._countryValue);
        country.add_child(new St.Label({style_class: 'pt-group-chevron', text: '›', y_align: CENTER}));
        this._countryRow.set_child(country);

        this._proxyRow = button('pt-group-row', () => this._act('proxy'));
        const proxy = new St.BoxLayout({x_expand: true});
        const text = new St.BoxLayout({...COLUMN, x_expand: true, y_align: CENTER});
        this._proxyLabel = new St.Label({style_class: 'pt-group-label'});
        this._proxySub = new St.Label({style_class: 'pt-group-sub'});
        text.add_child(this._proxyLabel);
        text.add_child(this._proxySub);
        this._knob = new St.Widget({style_class: 'pt-switch-knob', y_align: CENTER});
        this._switch = new St.Bin({style_class: 'pt-switch', y_align: CENTER, child: this._knob});
        proxy.add_child(text);
        proxy.add_child(this._switch);
        this._proxyRow.set_child(proxy);

        this._group.add_child(this._countryRow);
        this._group.add_child(this._proxyRow);
    }

    // The list of countries: Psiphon's fastest first, then the rest by name.
    _buildPicker() {
        this._picker = new St.BoxLayout({...COLUMN, style_class: 'pt-picker', visible: false});
        const head = new St.BoxLayout({style_class: 'pt-picker-head'});
        this._back = new St.Button({style_class: 'pt-picker-back', can_focus: true, y_align: CENTER});
        this._back.connect('clicked', () => this._pick(false));
        this._pickerTitle = new St.Label({style_class: 'pt-section-title', y_align: CENTER, x_expand: true,
            x_align: Clutter.ActorAlign.END});
        head.add_child(this._back);
        head.add_child(this._pickerTitle);

        this._chips = new St.BoxLayout({...COLUMN, style_class: 'pt-chips'});
        this._scroll = new St.ScrollView({
            style_class: 'pt-picker-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: false,     // a bar of its own, not over the right-hand chips
            child: this._chips,
        });
        this._pickerNote = wrap(new St.Label({style_class: 'pt-picker-note'}));

        this._picker.add_child(head);
        this._picker.add_child(this._scroll);
        this._picker.add_child(this._pickerNote);
    }

    _act(what, arg) {
        if (what === 'cancel') {
            this.confirm(null);
            return;
        }
        if (what === 'stop-now' || what === 'stop-later')
            this.confirm(null);
        this.onAction?.(what, arg);
    }

    _pick(open) {
        this._picking = open;
        if (open)
            this._confirm = null;
        if (this._model)
            this.update(this._model);
        if (open)
            this._chips.vadjustment?.set_value(0);
    }

    // The popup opened or closed.
    play() {
        this.scene.play();
    }

    pause() {
        this.scene.pause();
        this._picking = false;
        this.confirm(null);
    }

    // Show who would lose the tunnel, or hide the sheet (null).
    confirm(names) {
        this._confirm = names?.length ? names : null;
        if (this._model)
            this._syncControls();
    }

    // The popup is closed: keep the mole current, without a show.
    idle({state, region}) {
        this.mole.update({state, region, traffic: null});
        this.mole.settle();
    }

    update(model) {
        const old = this._model;
        this._model = model;
        if (this._lang !== T.code)
            this._relabel();
        this.mole.update({state: model.state, region: model.region,
            traffic: model.state === 'on' ? model.rates : null});
        if (!old || old.state !== model.state || old.region !== model.region)
            this.scene.wake();
        // the tunnel went away by itself: nothing left to confirm
        if (this._confirm && !RUNNING.has(model.state))
            this._confirm = null;
        if (this._picking && !this._canPick())
            this._picking = false;
        this._syncHead();
        this._syncControls();
        this._syncTiles();
        this._syncUsers();
        this._syncGroup();
        this._syncPicker();
        this._syncFooter();
    }

    // Labels that only change with the language.
    _relabel() {
        this._lang = T.code;
        this._chipsKey = null;
        this._now.label = T.sheet.now;
        this._cancel.label = T.sheet.cancel;
        this._keep.label = T.wait.keep;
        this._waitNow.label = T.wait.now;
        this._countryLabel.text = T.settings.country;
        this._proxyLabel.text = T.settings.proxy;
        this._back.label = `‹ ${T.picker.back}`;
        this._pickerTitle.text = T.picker.title;
    }

    _canPick() {
        const m = this._model;
        return m.installed && m.switching === null && !(m.pending && RUNNING.has(m.state)) &&
            m.state !== 'stopping' && m.state !== 'starting';
    }

    _syncHead() {
        const m = this._model;
        const switching = m.switching !== null && !RUNNING.has(m.state);
        // no Psiphon yet: say where it should be before anyone presses the button
        const missing = !m.installed && (m.state === 'off' || m.state === 'failed');
        const f = missing ? {kind: 'missing', path: m.bin} : m.failure;
        this._title.text = switching ? T.titles.switching
            : missing || m.state === 'failed' ? T.failed[f?.kind] ?? T.failed.crash : T.titles[m.state];
        let sub;
        switch (switching ? 'switching' : missing ? 'failed' : m.state) {
        case 'switching':
            sub = T.sub.switching(where(m.switching) || T.settings.fastest);
            break;
        case 'off': {
            const s = m.lastStop;
            if (s && m.now - s.at < STOP_NOTE) {
                sub = s.how === 'term' || s.how === 'gone' ? T.sub.closedIn(s.ms)
                    : s.how === 'kill' ? T.sub.killed(Math.round(s.grace / 1000)) : T.sub.stuck;
            } else {
                sub = T.sub.asleep;
            }
            break;
        }
        case 'starting':
            sub = T.sub.moment;
            break;
        case 'connecting':
            sub = T.sub.searching(formatClock(m.elapsed), where(m.chosen));
            break;
        case 'on':
            sub = `${where(m.region)} · ${T.duration(m.uptime)}`;
            break;
        case 'reconnecting':
            sub = T.sub.offline(formatClock(m.elapsed), where(m.region));
            break;
        case 'stopping':
            sub = T.sub.goodbye;
            break;
        default:
            if (f?.kind === 'port')
                sub = T.sub.portTaken(f.port);
            else if (f?.kind === 'missing')
                sub = T.sub.noFile(f.path.replace(m.home, '~'));
            else
                sub = f?.message ? T.sub.crashedWith(f.message) : T.sub.crashed;
        }
        this._subtitle.text = sub;
        toggle(this._subtitle, 'pt-good', m.state === 'on');
        toggle(this._subtitle, 'pt-bad', (m.state === 'failed' || missing) && !switching);
        toggle(this._subtitle, 'pt-busy', m.state === 'connecting' || m.state === 'reconnecting' || switching);
    }

    _syncControls() {
        const m = this._model;
        const running = RUNNING.has(m.state);
        const pending = m.pending && running;
        const sheet = !!this._confirm && running && !pending;

        let label = T.main.on, style = 'pt-main pt-primary', action = 'start', reactive = true;
        if (m.state === 'failed') {
            label = m.failure?.kind === 'crash' ? T.main.again : T.main.retry;
        } else if (m.state === 'stopping') {
            label = T.main.stopping;
            style = 'pt-main';
            reactive = false;
        } else if (running) {
            label = T.main.off;
            style = 'pt-main pt-secondary';
            action = 'stop';
            reactive = m.state !== 'starting';
        }
        this._main.label = label;
        this._main.style_class = style;
        this._main.reactive = reactive;
        this._main.can_focus = reactive;
        // between the old country and the new one there is nothing to press
        const switching = m.switching !== null && !running;
        this._main.visible = !sheet && !pending && !switching && !this._picking && m.installed;
        this._mainAction = action;

        this._sheet.visible = sheet;
        if (sheet) {
            this._sheetText.text = T.sheet.text(this._confirm);
            this._later.label = T.sheet.later(this._confirm);
        }

        this._wait.visible = !!pending && !this._picking;
        if (pending)
            this._waitText.text = m.pending.names.length ? T.wait.text(m.pending.names) : T.wait.stopping;
    }

    _syncTiles() {
        const m = this._model;
        const running = RUNNING.has(m.state) && m.state !== 'starting';
        this._grid.visible = running && !this._picking;
        if (!this._grid.visible)
            return;
        const [server, uptime, latency, traffic] = this._tiles;

        const sub = m.regionChanges ? T.tiles.changed(m.regionChanges) : m.chosen ? T.tiles.chosen : T.tiles.auto;
        server.set(T.tiles.server, m.region ? T.region(m.region) : T.tiles.searching, sub);

        const drops = T.tiles.drops(m.drops);
        if (m.state === 'on')
            uptime.set(T.tiles.open, T.duration(m.uptime), m.drops ? T.tiles.dropsIn(drops, T.duration(m.ran)) : drops);
        else
            uptime.set(T.tiles.running, T.duration(m.ran), drops);

        const l = m.latency;
        if (m.state !== 'on')
            latency.set(T.tiles.latency, '—', T.tiles.onceUp);
        else if (!l)
            latency.set(T.tiles.latency, '…', T.tiles.measuring);
        else if (l.error)
            latency.set(T.tiles.latency, T.tiles.noAnswer, T.tiles.checkFailed, 'red');
        else
            latency.set(T.tiles.latency, T.tiles.ms(l.ms), T.tiles.through, l.ms < 400 ? 'green' : l.ms < 1200 ? 'amber' : 'red');

        const r = m.rates;
        if (!r)
            traffic.set(T.tiles.traffic, '—', T.tiles.counting);
        else
            traffic.set(T.tiles.traffic, `↓ ${T.rate(r.down)}`, `↑ ${T.rate(r.up)}`);
    }

    _syncUsers() {
        const m = this._model;
        const list = m.users;
        const running = RUNNING.has(m.state);
        this._users.visible = (list.length > 0 || running) && !this._picking;
        if (!this._users.visible)
            return;
        this._rows.destroy_all_children();
        this._usersTitle.text = running ? T.users.through : T.users.waiting;
        this._usersRight.text = list.length ? T.users.count(list.length) : '';
        if (!list.length) {
            this._rows.add_child(new St.Label({style_class: 'pt-empty',
                text: m.state === 'on' ? T.users.nobodyNow : T.users.nobodyYet}));
            return;
        }
        for (const u of list.slice(0, MAX_ROWS)) {
            const row = new St.BoxLayout({style_class: 'pt-row'});
            const icon = new St.Icon({style_class: 'pt-row-icon', icon_size: 18, y_align: CENTER});
            if (u.gicon)
                icon.gicon = u.gicon;
            else
                icon.icon_name = u.iconName ?? 'application-x-executable-symbolic';
            const name = new St.Label({style_class: 'pt-row-name', text: u.count > 1 ? `${u.name} ×${u.count}` : u.name,
                x_expand: true, y_align: CENTER});
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            let right, cls = 'pt-row-right';
            if (!running) {
                right = T.users.waits;
            } else if (u.live && u.down + u.up >= 1024) {
                right = `↓ ${T.rate(u.down)}`;
                cls += ' pt-row-live';
            } else if (u.live) {
                right = T.users.live;
                cls += ' pt-row-live';
            } else if (u.last) {
                right = T.users.seen(m.now - u.last);
            } else {
                right = T.users.env;
            }
            row.add_child(icon);
            row.add_child(name);
            row.add_child(new St.Label({style_class: cls, text: right, y_align: CENTER}));
            this._rows.add_child(row);
        }
        if (list.length > MAX_ROWS)
            this._rows.add_child(new St.Label({style_class: 'pt-empty', text: T.users.more(list.length - MAX_ROWS)}));
    }

    _syncGroup() {
        const m = this._model;
        this._group.visible = m.installed && !this._picking;
        if (!this._group.visible)
            return;
        const can = this._canPick();
        this._countryRow.reactive = this._countryRow.can_focus = can;
        toggle(this._countryRow, 'pt-dim', !can);
        this._countryValue.text = m.chosen === null ? '—' : where(m.chosen) || T.settings.fastest;

        const p = m.proxy;
        toggle(this._switch, 'pt-on', p.want);
        this._knob.x_align = p.want ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        this._proxySub.text = !p.want ? T.settings.proxyIdle : p.applied ? T.settings.proxyOn : T.settings.proxyLater;
        this._proxyRow.accessible_name = `${T.settings.proxy}: ${this._proxySub.text}`;
    }

    _syncPicker() {
        const m = this._model;
        this._picker.visible = this._picking;
        if (!this._picking)
            return;
        const key = `${T.code}|${m.chosen}|${m.regions.join()}`;
        if (key !== this._chipsKey) {
            this._chipsKey = key;
            this._fillChips(m);
        }
        const running = RUNNING.has(m.state);
        this._pickerNote.text = running ? T.picker.restart : '';
        this._pickerNote.visible = running;
    }

    _fillChips(m) {
        this._chips.destroy_all_children();
        const codes = [...new Set([...m.regions, ...(m.chosen ? [m.chosen] : [])])]
            .sort((a, b) => T.region(a).localeCompare(T.region(b), T.code));
        const chip = (code, text, flag) => {
            const on = (m.chosen ?? '') === code;
            const b = new St.Button({style_class: `pt-chip${on ? ' pt-chip-on' : ''}`, can_focus: true, x_expand: true,
                accessible_name: text});
            const box = new St.BoxLayout({style_class: 'pt-chip-box', x_expand: true});
            box.add_child(new St.Label({style_class: 'pt-chip-flag', text: flag, y_align: CENTER}));
            const name = new St.Label({style_class: 'pt-chip-name', text, x_expand: true, y_align: CENTER});
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(name);
            b.set_child(box);
            b.connect('clicked', () => {
                this._pick(false);
                if (!on)
                    this.onAction?.('region', code);
            });
            return b;
        };
        const first = new St.BoxLayout({style_class: 'pt-chips-row'});
        first.add_child(chip('', T.picker.fastest, '⚡'));
        this._chips.add_child(first);
        for (let i = 0; i < codes.length; i += 2) {
            const row = new St.BoxLayout({style_class: 'pt-chips-row'});
            row.layout_manager.homogeneous = true;
            for (const code of codes.slice(i, i + 2))
                row.add_child(chip(code, T.region(code), flagEmoji(code)));
            if (codes.length - i === 1)
                row.add_child(new St.Widget({x_expand: true}));
            this._chips.add_child(row);
        }
        const rows = 1 + Math.ceil(codes.length / 2);
        this._scroll.style = `height: ${Math.min(rows * CHIP_ROW, PICKER_MAX)}px;`;
    }

    _syncFooter() {
        const m = this._model;
        const bits = [];
        if (m.ports.http)
            bits.push(`HTTP ${m.ports.http}`);
        if (m.ports.socks)
            bits.push(`SOCKS ${m.ports.socks}`);
        if (m.extra > 0)
            bits.push(T.copies(m.extra + 1));
        this._footer.text = bits.join(' · ');
        this._footer.visible = bits.length > 0;
    }
});
