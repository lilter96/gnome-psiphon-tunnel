// The popup: the mole at its hole, what the tunnel is doing, one button to
// open or close it, four tiles and the programs that go through it.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Mole} from './mole.js';
import {ago, flagEmoji, formatClock, formatDuration, formatRate, joinNames, plural, regionName} from './tunnel.js';
import {SceneView, animationsEnabled} from './ui.js';

const CENTER = Clutter.ActorAlign.CENTER;
const RUNNING = new Set(['starting', 'connecting', 'on', 'reconnecting']);
const MAX_ROWS = 5;
const STOP_NOTE = 10 * 60;      // how long "closed in 0.1 s" stays under the title

function wrap(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function button(label, style, onClick) {
    const b = new St.Button({label, style_class: style, can_focus: true, x_expand: true});
    b.connect('clicked', onClick);
    return b;
}

// A tile: a small caption, a value, one quiet line.
function makeTile() {
    const box = new St.BoxLayout({vertical: true, style_class: 'pt-tile', x_expand: true});
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

const TITLES = {
    off: 'Туннель выключен',
    starting: 'Запускаем Psiphon',
    connecting: 'Роем туннель…',
    on: 'Туннель открыт',
    reconnecting: 'Связь пропала, роем заново',
    stopping: 'Закрываем туннель',
};

const FAILED = {
    port: 'Порт занят',
    missing: 'Psiphon не найден',
    crash: 'Psiphon упал',
};

export const Card = GObject.registerClass(
class Card extends St.BoxLayout {
    _init() {
        super._init({vertical: true, style_class: 'pt-card'});
        this.onAction = null;
        this.mole = new Mole({reducedMotion: !animationsEnabled()});
        this.scene = new SceneView(this.mole);
        this._model = null;
        this._confirm = null;           // names, while the "are you sure" sheet is up

        this._title = new St.Label({style_class: 'pt-title', x_align: CENTER});
        this._subtitle = wrap(new St.Label({style_class: 'pt-subtitle', x_align: CENTER}));
        this._subtitle.clutter_text.line_alignment = Pango.Alignment.CENTER;

        this._main = button('', 'pt-main', () => this._act(this._mainAction));

        // closing the tunnel under someone's feet: say who, offer to wait
        this._sheet = new St.BoxLayout({vertical: true, style_class: 'pt-sheet', visible: false});
        this._sheetText = wrap(new St.Label({style_class: 'pt-sheet-text'}));
        this._sheetText.clutter_text.line_alignment = Pango.Alignment.CENTER;
        this._sheet.add_child(this._sheetText);
        this._later = button('', 'pt-sheet-btn pt-accent', () => this._act('stop-later'));
        for (const b of [
            button('Выключить сейчас', 'pt-sheet-btn pt-danger', () => this._act('stop-now')),
            this._later,
            button('Отмена', 'pt-sheet-btn', () => this._act('cancel')),
        ])
            this._sheet.add_child(b);

        // waiting for them to finish
        this._wait = new St.BoxLayout({vertical: true, style_class: 'pt-wait', visible: false});
        this._waitText = wrap(new St.Label({style_class: 'pt-wait-text'}));
        const waitRow = new St.BoxLayout({style_class: 'pt-wait-row'});
        waitRow.layout_manager.homogeneous = true;
        waitRow.add_child(button('Не выключать', 'pt-wait-btn', () => this._act('cancel-later')));
        waitRow.add_child(button('Выключить сейчас', 'pt-wait-btn pt-danger', () => this._act('stop-now')));
        this._wait.add_child(this._waitText);
        this._wait.add_child(waitRow);

        this._tiles = [0, 1, 2, 3].map(() => makeTile());
        this._grid = new St.BoxLayout({vertical: true, style_class: 'pt-tiles'});
        for (const pair of [this._tiles.slice(0, 2), this._tiles.slice(2)]) {
            const row = new St.BoxLayout({style_class: 'pt-tiles-row'});
            row.layout_manager.homogeneous = true;
            pair.forEach(t => row.add_child(t.box));
            this._grid.add_child(row);
        }

        this._users = new St.BoxLayout({vertical: true, style_class: 'pt-users'});
        const head = new St.BoxLayout({style_class: 'pt-section-head'});
        this._usersTitle = new St.Label({style_class: 'pt-section-title', x_expand: true, text: 'Через туннель'});
        this._usersRight = new St.Label({style_class: 'pt-section-right'});
        head.add_child(this._usersTitle);
        head.add_child(this._usersRight);
        this._rows = new St.BoxLayout({vertical: true, style_class: 'pt-rows'});
        this._users.add_child(head);
        this._users.add_child(this._rows);

        this._footer = wrap(new St.Label({style_class: 'pt-footer', x_align: CENTER}));
        this._footer.clutter_text.line_alignment = Pango.Alignment.CENTER;

        for (const a of [this.scene, this._title, this._subtitle, this._main, this._sheet, this._wait,
            this._grid, this._users, this._footer])
            this.add_child(a);
    }

    _act(what) {
        if (what === 'cancel') {
            this.confirm(null);
            return;
        }
        if (what === 'stop-now' || what === 'stop-later')
            this.confirm(null);
        this.onAction?.(what);
    }

    // The popup opened or closed.
    play() {
        this.scene.play();
    }

    pause() {
        this.scene.pause();
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
        this.mole.update({state: model.state, region: model.region,
            traffic: model.state === 'on' ? model.rates : null});
        if (!old || old.state !== model.state || old.region !== model.region)
            this.scene.wake();
        // the tunnel went away by itself: nothing left to confirm
        if (this._confirm && !RUNNING.has(model.state))
            this._confirm = null;
        this._syncHead();
        this._syncControls();
        this._syncTiles();
        this._syncUsers();
        this._syncFooter();
    }

    _syncHead() {
        const m = this._model;
        const f = m.failure;
        this._title.text = m.state === 'failed' ? FAILED[f?.kind] ?? FAILED.crash : TITLES[m.state];
        const where = m.region ? `${flagEmoji(m.region)} ${regionName(m.region)}`.trim() : '';
        let sub;
        switch (m.state) {
        case 'off': {
            const s = m.lastStop;
            if (s && m.now - s.at < STOP_NOTE) {
                sub = s.how === 'term' || s.how === 'gone'
                    ? `Закрыт аккуратно за ${(s.ms / 1000).toFixed(1).replace('.', ',')} с`
                    : s.how === 'kill' ? `Psiphon не ответил за ${Math.round(s.grace / 1000)} с, остановлен силой`
                        : 'Psiphon не останавливается, загляни в терминал';
            } else {
                sub = 'Крот спит, Psiphon не запущен';
            }
            break;
        }
        case 'starting':
            sub = 'Секунду…';
            break;
        case 'connecting':
            sub = `Ищем сервер · ${formatClock(m.elapsed)}`;
            break;
        case 'on':
            sub = `${where} · ${formatDuration(m.uptime)}`;
            break;
        case 'reconnecting':
            sub = `Без связи ${formatClock(m.elapsed)}${where ? ` · был ${where}` : ''}`;
            break;
        case 'stopping':
            sub = 'Psiphon прощается с сервером';
            break;
        default:
            if (f?.kind === 'port')
                sub = `Порт ${f.port} занят другой программой`;
            else if (f?.kind === 'missing')
                sub = `Нет файла ${f.path.replace(m.home, '~')}`;
            else
                sub = f?.message ? `Закрылся сам: ${f.message}` : 'Закрылся сам, не попрощавшись';
        }
        this._subtitle.text = sub;
        for (const [cls, on] of [['pt-good', m.state === 'on'], ['pt-bad', m.state === 'failed'],
            ['pt-busy', m.state === 'connecting' || m.state === 'reconnecting']]) {
            if (on)
                this._subtitle.add_style_class_name(cls);
            else
                this._subtitle.remove_style_class_name(cls);
        }
    }

    _syncControls() {
        const m = this._model;
        const running = RUNNING.has(m.state);
        const pending = m.pending && running;
        const sheet = !!this._confirm && running && !pending;

        let label = 'Включить', style = 'pt-main pt-primary', action = 'start', reactive = true;
        if (m.state === 'failed') {
            label = m.failure?.kind === 'crash' ? 'Запустить снова' : 'Попробовать снова';
        } else if (m.state === 'stopping') {
            label = 'Выключаем…';
            style = 'pt-main';
            reactive = false;
        } else if (running) {
            label = 'Выключить';
            style = 'pt-main pt-secondary';
            action = 'stop';
            reactive = m.state !== 'starting';
        }
        this._main.label = label;
        this._main.style_class = style;
        this._main.reactive = reactive;
        this._main.can_focus = reactive;
        this._main.visible = !sheet && !pending && m.failure?.kind !== 'missing';
        this._mainAction = action;

        this._sheet.visible = sheet;
        if (sheet) {
            const names = this._confirm, many = names.length > 1;
            this._sheetText.text = many
                ? `Через туннель работают ${joinNames(names)}. Если его закрыть, они останутся без связи.`
                : `Через туннель работает ${names[0]}. Если его закрыть, ${names[0]} останется без связи.`;
            this._later.label = many ? 'Когда они закроются' : `Когда закроется ${names[0]}`;
        }

        this._wait.visible = !!pending;
        if (pending) {
            const names = m.pending.names;
            this._waitText.text = names.length
                ? `Выключу, когда ${names.length > 1 ? 'закроются' : 'закроется'} ${joinNames(names)}`
                : 'Выключаю…';
        }
    }

    _syncTiles() {
        const m = this._model;
        const running = RUNNING.has(m.state) && m.state !== 'starting';
        this._grid.visible = running;
        if (!running)
            return;
        const [server, uptime, latency, traffic] = this._tiles;

        let sub = m.auto ? 'выбрал Psiphon' : 'задан в конфиге';
        if (m.regionChanges)
            sub = `сменился ${m.regionChanges} ${plural(m.regionChanges, 'раз', 'раза', 'раз')}`;
        server.set('Сервер', m.region ? regionName(m.region) : 'ищем…', sub);

        const drops = m.drops ? `${m.drops} ${plural(m.drops, 'обрыв', 'обрыва', 'обрывов')}` : 'без обрывов';
        if (m.state === 'on')
            uptime.set('Открыт', formatDuration(m.uptime), m.drops ? `${drops} за ${formatDuration(m.ran)}` : drops);
        else
            uptime.set('Psiphon работает', formatDuration(m.ran), drops);

        const l = m.latency;
        if (m.state !== 'on')
            latency.set('Отклик', '—', 'когда будет связь');
        else if (!l)
            latency.set('Отклик', '…', 'меряем');
        else if (l.error)
            latency.set('Отклик', 'нет ответа', 'проверка не прошла', 'red');
        else
            latency.set('Отклик', `${l.ms} мс`, 'через туннель', l.ms < 400 ? 'green' : l.ms < 1200 ? 'amber' : 'red');

        const r = m.rates;
        if (!r)
            traffic.set('Трафик', '—', 'считаем');
        else
            traffic.set('Трафик', `↓ ${formatRate(r.down)}`, `↑ ${formatRate(r.up)}`);
    }

    _syncUsers() {
        const m = this._model;
        const list = m.users;
        const running = RUNNING.has(m.state);
        this._users.visible = list.length > 0 || running;
        this._rows.destroy_all_children();
        this._usersTitle.text = running ? 'Через туннель' : 'Ждут туннель';
        this._usersRight.text = list.length ? `${list.length} ${plural(list.length, 'программа', 'программы', 'программ')}` : '';
        if (!list.length) {
            this._rows.add_child(new St.Label({style_class: 'pt-empty',
                text: m.state === 'on' ? 'Сейчас никто' : 'Пока никого'}));
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
                right = 'ждёт';
            } else if (u.live && u.down + u.up >= 1024) {
                right = `↓ ${formatRate(u.down)}`;
                cls += ' pt-row-live';
            } else if (u.live) {
                right = 'на связи';
                cls += ' pt-row-live';
            } else if (u.last) {
                right = `был ${ago(m.now - u.last)}`;
            } else {
                right = 'настроен на туннель';
            }
            row.add_child(icon);
            row.add_child(name);
            row.add_child(new St.Label({style_class: cls, text: right, y_align: CENTER}));
            this._rows.add_child(row);
        }
        if (list.length > MAX_ROWS) {
            this._rows.add_child(new St.Label({style_class: 'pt-empty',
                text: `и ещё ${list.length - MAX_ROWS}`}));
        }
    }

    _syncFooter() {
        const m = this._model;
        const bits = [];
        if (m.ports.http)
            bits.push(`HTTP ${m.ports.http}`);
        if (m.ports.socks)
            bits.push(`SOCKS ${m.ports.socks}`);
        if (m.extra > 0)
            bits.push(`запущено копий: ${m.extra + 1}`);
        this._footer.text = bits.join(' · ');
        this._footer.visible = bits.length > 0;
    }
});
