// Shell widgets for the mole: the animated scene and the panel glyph. All
// motion is driven by springs from kit.js.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {ColorSpring, Spring, clamp, pivotOf} from './kit.js';
import {GLYPH, HERO, LOOKS, SCENE, drawGlyph, drawParticle, particleBox, particleXf} from './mole.js';

const DEG = 180 / Math.PI;
const now = () => GLib.get_monotonic_time() / 1e6;

export const animationsEnabled = () => St.Settings.get().enable_animations;

// Sizes are in logical pixels; St wants physical ones on HiDPI screens.
const theme = () => St.ThemeContext.get_for_stage(global.stage);

export function followScale(actor, callback) {
    const ctx = theme();
    const id = ctx.connect('notify::scale-factor', () => callback(ctx.scale_factor));
    actor.connect('destroy', () => ctx.disconnect(id));
    callback(ctx.scale_factor);
}

// Calls back on every frame of the actor's monitor until stopped or the
// callback returns false.
export class FrameLoop {
    constructor(actor, callback) {
        this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => {
            const t = now();
            const dt = Math.min(t - this._last, 0.05);
            this._last = t;
            if (callback(dt) === false)
                this._timeline.stop();
        });
    }

    start() {
        if (this._timeline.is_playing())
            return;
        this._last = now();
        this._timeline.start();
    }

    stop() {
        this._timeline?.stop();
    }

    get playing() {
        return this._timeline?.is_playing() ?? false;
    }

    destroy() {
        this.stop();
        this._timeline = null;
    }
}

function applyXf(actor, cache, xf, k) {
    const tx = (xf.tx ?? 0) * k, ty = (xf.ty ?? 0) * k;
    const rot = (xf.rot ?? 0) * DEG;
    const sx = xf.sx ?? xf.s ?? 1, sy = xf.sy ?? xf.s ?? 1;
    const op = Math.round(clamp(xf.alpha ?? 1, 0, 1) * 255);
    if (cache.tx !== tx || cache.ty !== ty) {
        actor.set_translation(tx, ty, 0);
        cache.tx = tx;
        cache.ty = ty;
    }
    if (cache.rot !== rot) {
        actor.rotation_angle_z = rot;
        cache.rot = rot;
    }
    if (cache.sx !== sx || cache.sy !== sy) {
        actor.set_scale(sx, sy);
        cache.sx = sx;
        cache.sy = sy;
    }
    if (cache.op !== op) {
        actor.opacity = op;
        actor.visible = op > 0;
        cache.op = op;
    }
}

export function paintArea(area, box, k, draw) {
    const cr = area.get_context();
    cr.save();
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.restore();
    cr.scale(k, k);
    cr.translate(-box[0], -box[1]);
    draw(cr);
    cr.$dispose();
}

// The scene from mole.js as a tree of Clutter actors. Each layer is a
// texture that is redrawn only when its key changes; the rest is transforms.
// A layer with clip cuts its children at its box: the mole hides in its hole.
export const SceneView = GObject.registerClass(
class SceneView extends St.Widget {
    _init(mole) {
        super._init({reactive: true, x_align: Clutter.ActorAlign.CENTER});
        this.mole = mole;
        this._pose = mole.pose;
        this._layers = [];
        this._particles = new Map();
        this._loop = new FrameLoop(this, dt => this._frame(dt));
        this.connect('destroy', () => this._loop.destroy());
        followScale(this, f => this._rebuild(f));
    }

    // Textures are drawn at the final pixel size, so a new scale means new actors.
    _rebuild(factor) {
        this.destroy_all_children();
        this._layers = [];
        this._particles.clear();
        this._k = HERO.scale * factor;
        this.set_size(HERO.w * this._k, HERO.h * this._k);
        this._build(SCENE, this, HERO.x0, HERO.y0);
        this._sync();
    }

    _build(layers, parent, ox, oy) {
        const k = this._k;
        for (const l of layers) {
            const [bx, by, bw, bh] = l.box;
            const actor = l.draw
                ? new St.DrawingArea({width: bw * k, height: bh * k})
                : new St.Widget({width: bw * k, height: bh * k, clip_to_allocation: !!l.clip});
            actor.set_position((bx - ox) * k, (by - oy) * k);
            const [px, py] = pivotOf(l);
            actor.pivot_point = new Graphene.Point({x: (px - bx) / bw, y: (py - by) / bh});
            if (l.draw)
                actor.connect('repaint', area => paintArea(area, l.box, k, cr => l.draw(cr, this._pose)));
            parent.add_child(actor);
            this._layers.push({l, actor, key: undefined, cache: {}});
            if (l.children)
                this._build(l.children, actor, bx, by);
        }
    }

    _sync() {
        const p = this._pose = this.mole.pose;
        for (const r of this._layers) {
            if (r.l.key) {
                const key = r.l.key(p);
                if (key !== r.key) {
                    r.key = key;
                    r.actor.queue_repaint();
                }
            }
            if (r.l.xf)
                applyXf(r.actor, r.cache, r.l.xf(p), this._k);
        }

        const alive = new Set(p.particles);
        for (const [q, actor] of this._particles) {
            if (!alive.has(q)) {
                actor.destroy();
                this._particles.delete(q);
            }
        }
        for (const q of p.particles) {
            let actor = this._particles.get(q);
            if (!actor) {
                const box = particleBox(q.kind);
                const [bx, by, bw, bh] = box;
                const k = this._k;
                actor = new St.DrawingArea({width: bw * k, height: bh * k});
                actor.set_position((bx - HERO.x0) * k, (by - HERO.y0) * k);
                actor.pivot_point = new Graphene.Point({x: -bx / bw, y: -by / bh});
                actor.connect('repaint', area => paintArea(area, box, k, cr => drawParticle(cr, q.kind, q)));
                actor._cache = {};
                this.add_child(actor);
                this._particles.set(q, actor);
            }
            applyXf(actor, actor._cache, particleXf(q), this._k);
        }
    }

    _frame(dt) {
        this.mole.step(dt);
        this._sync();
        return this.mole.moving;
    }

    // The popup opened.
    play() {
        this.mole.reduced = !animationsEnabled();
        this.mole.intro();
        this._sync();
        this._loop.start();
    }

    pause() {
        this._loop.stop();
        this.mole.pointer(null);
    }

    // Something changed while the popup is open.
    wake() {
        if (this.mapped)
            this._loop.start();
        else
            this._sync();
    }

    vfunc_motion_event(event) {
        const [x, y] = event.get_coords();
        const [ok, lx, ly] = this.transform_stage_point(x, y);
        if (ok)
            this.mole.pointer([lx / this._k + HERO.x0, ly / this._k + HERO.y0]);
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_leave_event(event) {
        this.mole.pointer(null);
        return super.vfunc_leave_event(event);
    }

    vfunc_button_press_event() {
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event() {
        this.mole.poke();
        this._loop.start();
        return Clutter.EVENT_STOP;
    }
});

const PULSE_FOR = 30;       // seconds of a blinking lamp, then it just stays amber
const LAMP_ON = {off: 0, stopping: 0, starting: 1, connecting: 1, reconnecting: 1, on: 1, failed: 1};

// The miner's helmet in the panel. The lamp tells the state: green open,
// amber digging, red failed, dark off. It moves only when something changes,
// and the digging blink gives up after half a minute.
export const PanelGlyph = GObject.registerClass(
class PanelGlyph extends St.DrawingArea {
    _init() {
        super._init({y_align: Clutter.ActorAlign.CENTER});
        followScale(this, f => {
            this._k = f;
            this.set_size(GLYPH.w * f, GLYPH.h * f);
        });
        this._s = {
            scale: new Spring(1, 0.5, 0.55),
            roll: new Spring(0, 0.42, 0.3),
            dy: new Spring(0, 0.3, 0.45),
            on: new Spring(0, 0.35),
            dim: new Spring(1, 0.5),
            pending: new Spring(0, 0.45, 0.6),
        };
        this._lamp = new ColorSpring(LOOKS.off.color, 0.5);
        this._state = null;
        this._pulse = null;
        this._loop = new FrameLoop(this, dt => this._frame(dt));
        this.connect('destroy', () => {
            this._stopPulse();
            this._loop.destroy();
        });
    }

    set({state, pending}) {
        const s = this._s;
        if (state !== this._state) {
            const was = this._state;
            this._state = state;
            this._lamp.to(LOOKS[state].color);
            s.on.to(LAMP_ON[state]);
            s.dim.to(state === 'off' || state === 'stopping' ? 1 : 0);
            if (state === 'on' && was) {
                s.dy.kick(-36);
                s.scale.kick(2.5);
            }
            if (state === 'failed')
                s.roll.kick(3.2);
            if (['starting', 'connecting', 'reconnecting'].includes(state))
                this._startPulse();
            else
                this._stopPulse();
        }
        s.pending.to(pending ? 1 : 0);
        this._kick();
    }

    pop() {
        this._s.scale.snap(0.35);
        this._s.scale.to(1);
        this._kick();
    }

    // A blink every 0.9 s while Psiphon looks for a server, for half a minute.
    _startPulse() {
        if (this._pulse)
            return;
        let n = 0;
        this._pulse = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
            if (++n > PULSE_FOR / 0.9) {
                this._pulse = null;
                this._s.on.to(1);
                this._kick();
                return GLib.SOURCE_REMOVE;
            }
            this._s.on.to(n % 2 ? 0.25 : 1);
            this._kick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPulse() {
        if (this._pulse)
            GLib.source_remove(this._pulse);
        this._pulse = null;
    }

    // Off screen or with animations off: land on the final pose at once.
    _kick() {
        if (!animationsEnabled() || !this.mapped) {
            for (const sp of Object.values(this._s))
                sp.snap(sp.target);
            [this._lamp.L, this._lamp.C, this._lamp.h].forEach(sp => sp.snap(sp.target));
            this.queue_repaint();
            return;
        }
        this._loop.start();
    }

    _frame(dt) {
        const springs = Object.values(this._s);
        springs.forEach(sp => sp.step(dt));
        this._lamp.step(dt);
        this.queue_repaint();
        return !springs.every(sp => sp.resting) || !this._lamp.resting;
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const s = this._s;
        const cr = this.get_context();
        cr.scale(this._k, this._k);
        const fg = this.get_theme_node().get_foreground_color();
        drawGlyph(cr, [fg.red / 255, fg.green / 255, fg.blue / 255, fg.alpha / 255], {
            lamp: this._lamp.rgb,
            on: clamp(s.on.x, 0, 1),
            dim: clamp(s.dim.x, 0, 1),
            pending: clamp(s.pending.x, 0, 1),
            roll: s.roll.x,
            dy: s.dy.x,
            scale: Math.max(s.scale.x, 0),
        });
        cr.$dispose();
    }
});
