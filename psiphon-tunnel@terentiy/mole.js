// The mole: a miner who keeps your tunnel. It sleeps in its hole while
// Psiphon is off, digs while Psiphon looks for a server, pops out with its
// lamp on and plants the server's flag once the tunnel is up, and looks
// dizzy if Psiphon falls over. Packets run round the ring with the traffic.
//
// Drawn with Cairo and animated with springs; no Shell imports, so it also
// renders under plain gjs. Coordinates are "hill units": the backdrop disc
// has radius 100 and is centred at the origin, y grows downwards.

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {
    BLACK, ColorSpring, Spring, TAU, WHITE, clamp, colorKey, ellipse, hex, linear, mirrored, mix,
    pat, path, pivotOf, qz, radial, smooth, src, withXf,
} from './kit.js';
import {flagEmoji} from './tunnel.js';

export const HERO = {scale: 0.62, x0: -124, y0: -124, w: 248, h: 248};

const AMBER = '#ffb340';
// colour of the scene and of the lamp, per state
export const LOOKS = {
    off: {color: hex('#8e8e93'), lamp: hex('#4b4b55')},
    starting: {color: hex(AMBER), lamp: hex('#ffd27a')},
    connecting: {color: hex(AMBER), lamp: hex('#ffd27a')},
    reconnecting: {color: hex(AMBER), lamp: hex('#ffd27a')},
    on: {color: hex('#30d158'), lamp: hex('#eafff1')},
    stopping: {color: hex('#8e8e93'), lamp: hex('#4b4b55')},
    failed: {color: hex('#ff453a'), lamp: hex('#ff7a6e')},
};

const FUR_HI = hex('#8a7f96');
const FUR = hex('#5d5268');
const FUR_SH = hex('#3b3245');
const MUZZLE = hex('#b3a5b5');
const MUZZLE_SH = hex('#8f8095');
const NOSE = hex('#ff8fa8');
const NOSE_HI = hex('#ffd3de');
const NOSE_SH = hex('#d65f7e');
const PAW = hex('#f6aebd');
const PAW_SH = hex('#d27f93');
const CLAW = hex('#fff6e3');
const CLAW_SH = hex('#cdb894');
const HELMET = hex('#ffc93c');
const HELMET_HI = hex('#ffe794');
const HELMET_SH = hex('#df961a');
const HELMET_DEEP = hex('#a8670c');
const RIM_METAL = hex('#3a3a44');
const SOIL_TOP = hex('#a87c56');
const SOIL = hex('#7b553a');
const SOIL_DEEP = hex('#4a3122');
const DIRT = hex('#bf9168');
const DIRT_SH = hex('#8a6143');
const HOLE_DARK = hex('#150e0a');
const GRASS = hex('#6cc070');
const LINE = hex('#251d2b');
const EYE = hex('#17121c');
const POLE = hex('#d9dbe3');
const STAR = hex('#ffd60a');
const SWEAT = hex('#8fd5ff');

// --- geometry --------------------------------------------------------------------

const RING_R = 113;
const RING_W = 8;
const HOLE = {y: 34, rx: 42, ry: 10};
const RIM = {y: 35.5, rx: 51, ry: 14};
const CLIP_Y = 39;          // the mole is cut here, out of sight behind the front lip
const SINK = 74;            // how far down it goes to sleep
const LAMP = [0, -50];
const SHOULDER = [-23, 6];
const FLAG_BASE = [66, 33];
const MOUND = {y: 136, rx: 170, ry: 118};

const BODY = 'M 0 -47 C 21 -47 34 -33 35 -12 C 36 6 39 24 42 44 L 44 84 L -44 84 L -42 44 ' +
    'C -39 24 -36 6 -35 -12 C -34 -33 -21 -47 0 -47 Z';
const DOME = 'M -31 -35 C -31 -57 -17 -71 0 -71 C 17 -71 31 -57 31 -35 Z';
const RIDGE = 'M -4.5 -70.4 L 4.5 -70.4 L 5.5 -36 L -5.5 -36 Z';
const ZED = 'M -4 -4 L 4 -4 L -4 4 L 4 4';
const DROP = 'M 0 -6 C 2.5 -2 4 0.5 4 2.6 C 4 5 2.2 6.6 0 6.6 C -2.2 6.6 -4 5 -4 2.6 C -4 0.5 -2.5 -2 0 -6 Z';
const HEART = 'M 0 6 C -10 -1 -8 -9 -2.8 -8 C -1.2 -7.7 -0.4 -6.6 0 -5.5 C 0.4 -6.6 1.2 -7.7 2.8 -8 C 8 -9 10 -1 0 6 Z';

const surfaceY = x => MOUND.y - MOUND.ry * Math.sqrt(Math.max(0, 1 - (x / MOUND.rx) ** 2));

// Blink: lids drop in 70 ms, rise in 120 ms.
function blinkCurve(t) {
    if (t < 0 || t > 0.19)
        return 1;
    return t < 0.07 ? 1 - smooth(0, 0.07, t) : smooth(0.07, 0.19, t);
}

const DIGGING = new Set(['starting', 'connecting', 'reconnecting']);

// --- behaviour -------------------------------------------------------------------

export class Mole {
    constructor({random = Math.random, reducedMotion = false} = {}) {
        this.rand = random;
        this.reduced = reducedMotion;
        this.t = 0;
        this.state = 'off';
        this.region = null;
        this.traffic = null;
        this.particles = [];
        this.next = {blink: 1.2, glance: 1.4, z: 0.5, clod: 0, sniff: 3, sweat: 1.2, pkt: 0};
        this.look = [0, 0];
        this.pointerAt = null;
        this.blinkAt = -1;
        this.wokeUntil = -1;        // a poke wakes it up for a while
        this.waveUntil = -1;        // waving goodbye before going down
        this.happyUntil = -1;
        this.digPhase = 0;
        this.breathPhase = 0;
        this.spin = 0;
        this._blink = 1;
        this._colored = false;

        const S = (x, r, d) => new Spring(x, r, d);
        this.color = new ColorSpring(LOOKS.off.color);
        this.lampColor = new ColorSpring(LOOKS.off.lamp, 0.45);
        this.s = {
            rise: S(0, 0.6, 0.62),          // 0 asleep in the hole … 1 out to the chest
            hop: S(0, 0.26, 0.42),          // a kick up or down, in hill units
            roll: S(0, 0.45, 0.35),
            lookX: S(0, 0.25, 0.8), lookY: S(0, 0.25, 0.8),
            open: S(0, 0.22), happy: S(0, 0.25), dizzy: S(0, 0.4), squint: S(0, 0.2), worry: S(0, 0.4),
            lamp: S(0, 0.3), beam: S(0, 0.6), beamRot: S(0, 0.8, 0.75),
            pawL: S(0, 0.2, 0.55), pawR: S(0, 0.2, 0.55),
            helmet: S(0, 0.4, 0.4), helmetDy: S(0, 0.25, 0.4),
            nose: S(1, 0.16, 0.35), mouth: S(0, 0.2, 0.6),
            flag: S(0, 0.5, 0.45), flagRot: S(0, 0.6, 0.35),
            sweep: S(0, 1.0, 0.9), ringA: S(0, 0.5), night: S(1, 1.2),
            flare: S(0, 0.5),
        };
    }

    get awake() {
        return this.state !== 'off' || this.t < this.wokeUntil || this.t < this.waveUntil;
    }

    get asleep() {
        return !this.awake;
    }

    // update({state, region, traffic: {down, up} | null})
    update({state, region, traffic = null}) {
        const old = this.state, oldRegion = this.region;
        this.state = state;
        if (region !== undefined)
            this.region = region;
        this.traffic = traffic;
        const look = LOOKS[state] ?? LOOKS.off;
        this.color.to(look.color, !this._colored);
        this.lampColor.to(look.lamp, !this._colored);
        if (!this._colored) {
            // the first state is where we start, not a change to animate
            this._colored = true;
            this.settle();
            return;
        }
        if (state === 'on' && old === 'on' && this.region !== oldRegion && this.region) {
            // a new server: the flag goes down and comes back with the new colours
            this.s.flag.from(0.15);
            this._sparkle(FLAG_BASE[0] + 12, FLAG_BASE[1] - 44, 4);
        }
        if (old === state)
            return;
        const t = this.t, s = this.s;
        if (DIGGING.has(state) && !DIGGING.has(old)) {
            if (old === 'off' || old === 'failed' || old === 'stopping') {
                // up with a start
                s.hop.kick(-160);
                s.helmetDy.kick(-90);
                this._emit('bang', 26, this._headY() - 46, 0, -12, 1.0);
            }
        }
        if (state === 'on' && old !== 'on') {
            s.hop.kick(-210);
            s.helmet.kick(this.rand() < 0.5 ? -2.4 : 2.4);
            s.flag.from(0);
            s.flare.from(1);
            this.happyUntil = t + 1.8;
            this._sparkle(LAMP[0], LAMP[1] + this._ty(), 7);
        }
        if (state === 'reconnecting')
            this._emit('drop', 30, this._headY() - 20, 0, 8, 1.6);
        if ((state === 'stopping' || state === 'off') && (old === 'on' || DIGGING.has(old) || old === 'stopping')) {
            // a wave goodbye, then down into the hole
            if (old !== 'stopping')
                this.waveUntil = t + 1.15;
        }
        if (state === 'failed') {
            s.roll.kick(2.6);
            s.helmet.kick(-3);
            this.particles = this.particles.filter(q => q.kind !== 'pkt');
        }
    }

    // Popup opened: the ring sweeps in, the mole pops up.
    intro() {
        const s = this.s;
        this.particles = [];
        if (this.reduced) {
            this.settle();
            return;
        }
        s.sweep.from(0);
        if (this.state === 'on') {
            s.rise.from(0.55);
            s.flag.from(0);
            this.next.blink = this.t + 0.5;
        } else if (this.asleep) {
            s.helmet.kick(1.2);
        }
    }

    // Jump straight to the resting pose (reduced motion, the first frame).
    settle() {
        this.step(0);
        for (const sp of Object.values(this.s))
            sp.snap(sp.target);
        for (const c of [this.color, this.lampColor])
            [c.L, c.C, c.h].forEach(sp => sp.snap(sp.target));
        this.particles = [];
        this.waveUntil = -1;
    }

    // Pointer position in hill units, or null when it leaves.
    pointer(p) {
        if (p && !this.pointerAt && this.asleep)
            this.s.helmet.kick(1.6);
        this.pointerAt = p;
    }

    // A click on the mole.
    poke() {
        const s = this.s;
        if (this.asleep) {
            // wakes up, looks around, goes back to sleep
            this.wokeUntil = this.t + 3.4;
            s.hop.kick(-120);
            s.helmetDy.kick(-80);
            this._emit('bang', 26, this._headY() - 40, 0, -12, 1.0);
            return;
        }
        if (this.state === 'failed') {
            s.roll.kick(this.rand() < 0.5 ? -2 : 2);
            return;
        }
        if (DIGGING.has(this.state)) {
            for (let i = 0; i < 6; i++)
                this._clod(i % 2 ? 1 : -1, 1.3);
            return;
        }
        // ducks and pops back up
        s.hop.kick(260);
        s.helmet.kick(this.rand() < 0.5 ? -2 : 2);
        this._emit('heart', 0, this._headY() - 46, 0, -40, 1.3);
        this.happyUntil = this.t + 1.2;
    }

    _ty() {
        return SINK * (1 - this.s.rise.x) + this.s.hop.x * 0.1;
    }

    _headY() {
        return -20 + this._ty();
    }

    _emit(kind, x, y, vx, vy, life, extra = {}) {
        this.particles.push({kind, x, y, vx, vy, life, age: 0, seed: this.rand() * TAU, ...extra});
    }

    _clod(side, strength = 1) {
        const R = this.rand;
        this._emit('clod', side * (14 + R() * 18), HOLE.y - 6,
            side * (40 + R() * 60) * strength, -(110 + R() * 70) * strength, 1.1 + R() * 0.4,
            {g: 330, size: 0.7 + R() * 0.6});
    }

    _sparkle(x, y, n) {
        for (let i = 0; i < n; i++) {
            const a = -Math.PI / 2 + (this.rand() - 0.5) * 2.6;
            const v = 50 + this.rand() * 60;
            this._emit('spark', x, y, Math.cos(a) * v, Math.sin(a) * v, 0.8 + this.rand() * 0.4);
        }
    }

    step(dt) {
        dt = Math.min(dt, 0.05);
        const t = this.t += dt;
        const R = this.rand, s = this.s, st = this.state;
        const lively = !this.reduced;
        const asleep = this.asleep;
        const digging = DIGGING.has(st);
        const waving = t < this.waveUntil;
        const up = st === 'on';
        const failed = st === 'failed';
        const happy = t < this.happyUntil;

        this.color.to((LOOKS[st] ?? LOOKS.off).color);
        this.lampColor.to((LOOKS[st] ?? LOOKS.off).lamp);

        // Where the mole is: asleep in the hole, digging half out, out to the chest.
        let rise = 1;
        if (asleep)
            rise = 0;
        else if (waving)
            rise = 0.95;
        else if (st === 'off' || st === 'stopping')
            rise = 0.5;         // poked awake
        else if (digging)
            rise = 0.57 + (lively ? 0.05 * Math.sin(this.digPhase * 0.5) : 0);
        else if (failed)
            rise = 0.84;
        s.rise.tune(asleep ? 1.1 : 0.6, asleep ? 1 : 0.62).to(rise);
        s.hop.to(0);

        // Paws: dig in turns, wave goodbye, rest on the rim.
        let pawL = 0, pawR = 0;
        if (digging && lively) {
            this.digPhase += dt * 10.5;
            pawL = 0.22 + 0.42 * Math.max(0, Math.sin(this.digPhase));
            pawR = 0.22 + 0.42 * Math.max(0, Math.sin(this.digPhase + Math.PI));
            if (t >= this.next.clod) {
                this._clod(Math.sin(this.digPhase) > 0 ? -1 : 1);
                this.next.clod = t + 0.1 + R() * 0.16;
            }
        } else if (digging) {
            pawL = pawR = 0.3;
        }
        if (waving)
            pawR = 1.75 + (lively ? 0.28 * Math.sin((t - this.waveUntil) * 15) : 0);
        else if (happy && up)
            pawL = pawR = 0.18;
        s.pawL.to(pawL);
        s.pawR.to(pawR);

        // Eyes.
        let blink = 1;
        if (!asleep && lively && !digging && !failed) {
            if (t >= this.next.blink) {
                this.blinkAt = t;
                this.next.blink = t + 2 + R() * 4;
            }
            blink = blinkCurve(t - this.blinkAt);
        }
        s.open.tune(asleep ? 1.4 : 0.22).to(asleep ? 0 : 1);
        s.happy.to(happy && !asleep ? 1 : 0);
        s.squint.to(digging && st !== 'reconnecting' ? 1 : 0);
        s.dizzy.to(failed ? 1 : 0);
        s.worry.to(st === 'reconnecting' ? 1 : 0);
        s.mouth.to(happy ? 0.7 : failed ? 0.45 : 0);

        // Gaze: the pointer, otherwise a glance around now and then.
        if (asleep) {
            this.look = [0, 0.4];
        } else if (digging) {
            this.look = [Math.sin(this.digPhase * 0.25) * 0.4, 0.55];
        } else if (this.pointerAt) {
            const [px, py] = this.pointerAt;
            this.look = [clamp(px / 70, -1, 1), clamp((py - this._headY()) / 60, -1, 1)];
        } else if (lively && t >= this.next.glance) {
            this.look = R() < 0.35 ? [0, 0] : [R() * 2 - 1, (R() * 2 - 1) * 0.5];
            this.next.glance = t + 1.6 + R() * 3.5;
        }
        s.lookX.to(this.look[0]);
        s.lookY.to(this.look[1]);
        s.roll.to((asleep ? 0.06 : 0) + s.lookX.x * 0.04 +
            (failed && lively ? 0.07 * Math.sin(t * 2.4) : 0));

        // The nose sniffs the air now and then.
        if (up && lively && t >= this.next.sniff) {
            s.nose.kick(2.2);
            this.next.sniff = t + 2.5 + R() * 4;
        }
        s.nose.to(1);

        // Helmet: slips forward in sleep, askew when things go wrong.
        s.helmet.to(asleep ? 0.1 : failed ? -0.16 : 0);
        s.helmetDy.to(0);

        // Lamp and beam.
        let lamp = 0;
        if (!asleep && st !== 'off' && st !== 'stopping')
            lamp = 1;
        if (digging && lively)
            lamp = 0.78 + 0.22 * Math.sin(t * 19) * Math.sin(t * 7.3);
        if (failed)
            lamp = lively ? 0.55 + 0.25 * Math.max(0, Math.sin(t * 5)) : 0.6;
        s.lamp.to(lamp);
        s.beam.to(up ? 1 : digging ? 0.65 : failed ? 0.25 : 0);
        s.beamRot.to(digging && lively ? Math.sin(t * 2.1) * 0.5 : up ? s.lookX.x * 0.45 : 0);

        // Flag of the server's country, once the tunnel is up.
        const flagUp = this.region && (up || (st === 'reconnecting' && s.flag.x > 0.05));
        s.flag.to(flagUp ? 1 : 0);
        s.flagRot.to(st === 'reconnecting' ? 0.55 : up && lively ? 0.05 * Math.sin(t * 1.7) : 0);

        // Ring: a spinner while digging, closed when the tunnel is up.
        s.sweep.to(up || failed ? 1 : digging ? 0.24 : 0);
        s.ringA.to(st === 'off' || st === 'stopping' ? 0 : 1);
        if (digging && lively)
            this.spin += dt * 4.4;
        s.night.to(asleep ? 1 : st === 'off' ? 0.6 : 0);
        s.flare.to(0);

        // Particles that come and go on their own.
        if (asleep && lively && t >= this.next.z) {
            this._emit('z', 16, HOLE.y - 26, 12, -22, 2.8);
            this.next.z = t + 1.7;
        }
        if (st === 'reconnecting' && lively && t >= this.next.sweat) {
            this._emit('drop', 28, this._headY() - 18, 0, 10, 1.4);
            this.next.sweat = t + 2.6 + R();
        }
        if (failed && lively && this.particles.filter(q => q.kind === 'star').length < 3) {
            const n = this.particles.filter(q => q.kind === 'star').length;
            this._emit('star', 0, 0, 0, 0, 3.2, {phase: n * TAU / 3 + R() * 0.3});
        }
        if (up && lively && this.traffic) {
            // the busier the tunnel, the more packets run round the ring
            const total = this.traffic.down + this.traffic.up;
            const rate = total > 64 ? Math.min(10, 1.6 * Math.log10(1 + total / 512)) : 0;
            if (rate > 0 && t >= this.next.pkt) {
                const down = R() < this.traffic.down / Math.max(total, 1);
                this._emit('pkt', 0, 0, 0, 0, 1.3 + R() * 0.6, {
                    a0: R() * TAU,
                    w: (down ? -1 : 1) * (1.5 + R() * 0.8),
                    down,
                });
                this.next.pkt = t + 1 / rate * (0.5 + R());
            }
        }

        this.breathPhase += dt * TAU / (asleep ? 4.6 : 3.2);

        for (const sp of Object.values(s))
            sp.step(dt);
        this.color.step(dt);
        this.lampColor.step(dt);

        for (const q of this.particles) {
            q.age += dt;
            q.x += q.vx * dt;
            q.y += q.vy * dt;
            if (q.g)
                q.vy += q.g * dt;
        }
        this.particles = this.particles.filter(q => q.age < q.life);
        this._blink = blink;
    }

    // True while something still moves; with reduced motion the loop can stop.
    get moving() {
        return !this.reduced || this.particles.length > 0 ||
            Object.values(this.s).some(sp => !sp.resting) ||
            !this.color.resting || !this.lampColor.resting;
    }

    get pose() {
        const s = this.s;
        const breath = Math.sin(this.breathPhase);
        return {
            t: this.t,
            color: this.color.rgb,
            ring: {sweep: clamp(s.sweep.x, 0, 1), alpha: clamp(s.ringA.x, 0, 1), spin: this.spin,
                flare: clamp(s.flare.x, 0, 1)},
            night: clamp(s.night.x, 0, 1),
            mole: {
                ty: SINK * (1 - s.rise.x) + s.hop.x * 0.1,
                rot: s.roll.x,
                sy: 1 + 0.014 * breath * (this.reduced ? 0 : 1),
            },
            look: {x: s.lookX.x, y: s.lookY.x},
            eyes: {
                open: clamp(s.open.x, 0, 1) * this._blink,
                happy: clamp(s.happy.x, 0, 1),
                squint: clamp(s.squint.x, 0, 1),
                dizzy: clamp(s.dizzy.x, 0, 1),
                worry: clamp(s.worry.x, 0, 1),
            },
            nose: s.nose.x,
            mouth: clamp(s.mouth.x, 0, 1),
            helmet: {rot: s.helmet.x, dy: s.helmetDy.x * 0.06},
            lamp: {on: clamp(s.lamp.x, 0, 1), color: this.lampColor.rgb},
            beam: {alpha: clamp(s.beam.x, 0, 1) * clamp(s.lamp.x, 0, 1), rot: s.beamRot.x},
            pawL: s.pawL.x,
            pawR: s.pawR.x,
            flag: {s: Math.max(s.flag.x, 0), rot: s.flagRot.x, code: this.region},
            particles: this.particles,
        };
    }
}

// --- scene -----------------------------------------------------------------------

const PAW_SWING = 2.3;

export const SCENE = [
    {id: 'disc', box: [-104, -104, 208, 208], key: p => colorKey(p.color), draw: drawDisc},
    {id: 'stars', box: [-90, -90, 180, 110], draw: drawStars, xf: p => ({alpha: p.night})},
    {id: 'ring', box: [-124, -124, 248, 248], pivot: [0, 0], draw: drawRing,
        key: p => `${qz(p.ring.sweep, 0.004)}|${qz(p.ring.flare, 0.05)}|${colorKey(p.color)}`,
        xf: p => ({rot: p.ring.sweep < 0.999 ? p.ring.spin : 0, alpha: p.ring.alpha})},
    {id: 'ground', box: [-104, -14, 208, 118], draw: drawGround},
    {id: 'flag', box: [56, -26, 44, 64], pivot: FLAG_BASE, draw: drawFlag,
        key: p => p.flag.code ?? '',
        xf: p => ({s: p.flag.s, rot: p.flag.rot, alpha: clamp(p.flag.s * 3, 0, 1)})},
    {id: 'pit', box: [-104, -104, 208, 104 + CLIP_Y], clip: true, children: [
        {id: 'mole', box: [-60, -110, 120, 200], pivot: [0, 40],
            xf: p => ({ty: p.mole.ty, rot: p.mole.rot, sy: p.mole.sy}),
            children: [
                {id: 'beam', box: [-8, -130, 90, 90], pivot: LAMP, draw: drawBeam,
                    key: p => colorKey(p.lamp.color),
                    xf: p => ({rot: p.beam.rot, alpha: p.beam.alpha})},
                {id: 'body', box: [-48, -50, 96, 136], draw: drawBody},
                {id: 'face', box: [-40, -36, 80, 48],
                    xf: p => ({tx: p.look.x * 3.2, ty: p.look.y * 2.2}),
                    children: [
                        {id: 'muzzle', box: [-36, -24, 72, 32], draw: drawMuzzle},
                        {id: 'eyes', box: [-24, -32, 48, 24], draw: drawEyes,
                            key: p => `${qz(p.eyes.open, 0.02)}|${qz(p.eyes.happy, 0.05)}|${qz(p.eyes.squint, 0.05)}|` +
                                `${qz(p.eyes.dizzy, 0.05)}|${qz(p.eyes.worry, 0.05)}|${qz(p.look.x, 0.05)}|${qz(p.look.y, 0.05)}`},
                        {id: 'mouth', box: [-10, -6, 20, 14], draw: drawMouth, key: p => qz(p.mouth, 0.05)},
                        {id: 'nose', box: [-12, -18, 24, 16], pivot: [0, -10], draw: drawNose,
                            xf: p => ({sx: 1 + (p.nose - 1) * 0.6, sy: p.nose})},
                    ]},
                {id: 'helmet', box: [-40, -76, 80, 48], pivot: [0, -35],
                    xf: p => ({rot: p.helmet.rot, ty: p.helmet.dy, tx: p.look.x * 1.4}),
                    children: [
                        {id: 'shell', box: [-40, -76, 80, 48], draw: drawHelmet},
                        {id: 'lamp', box: [-30, -80, 60, 60], draw: drawLamp,
                            key: p => `${qz(p.lamp.on, 0.02)}|${colorKey(p.lamp.color)}`},
                    ]},
                {id: 'pawL', box: [-48, 6, 36, 36], pivot: SHOULDER, draw: cr => drawPaw(cr, -1),
                    xf: p => ({rot: p.pawL * PAW_SWING})},
                {id: 'pawR', box: [12, 6, 36, 36], pivot: [-SHOULDER[0], SHOULDER[1]], draw: cr => drawPaw(cr, 1),
                    xf: p => ({rot: -p.pawR * PAW_SWING})},
            ]},
        {id: 'shade', box: [-46, 18, 92, 22], draw: drawShade},
    ]},
    {id: 'lip', box: [-56, 26, 112, 26], draw: drawLip},
];

export const PARTICLE_BOX = {
    bang: [-8, -16, 16, 32],
    heart: [-12, -12, 24, 24],
    default: [-8, -8, 16, 16],
};
export const particleBox = kind => PARTICLE_BOX[kind] ?? PARTICLE_BOX.default;

export function particleXf(q) {
    const k = q.age / q.life;
    const a = smooth(0, 0.12, k) * (1 - smooth(0.6, 1, k));
    switch (q.kind) {
    case 'z':
        return {tx: q.x + 4 * Math.sin(q.seed + q.age * 1.6), ty: q.y, s: 0.6 + 0.6 * k, alpha: 0.7 * a};
    case 'clod':
        return {tx: q.x, ty: q.y, rot: q.seed + q.age * 7, s: q.size, alpha: 1 - smooth(0.75, 1, k)};
    case 'pkt': {
        const ang = q.a0 + q.w * q.age;
        return {tx: RING_R * Math.cos(ang), ty: RING_R * Math.sin(ang), s: 0.7 + 0.3 * Math.sin(k * Math.PI),
            alpha: smooth(0, 0.15, k) * (1 - smooth(0.7, 1, k))};
    }
    case 'star': {
        const ang = q.phase + q.age * 2.4;
        return {tx: 30 * Math.cos(ang), ty: -66 + SINK * 0.16 + 8 * Math.sin(ang), s: 0.75 + 0.2 * Math.sin(ang),
            alpha: smooth(0, 0.1, k) * (1 - smooth(0.85, 1, k))};
    }
    case 'spark':
        return {tx: q.x, ty: q.y, rot: q.age * 4, s: 0.5 + 0.7 * (1 - k), alpha: 1 - smooth(0.5, 1, k)};
    case 'bang':
        return {tx: q.x, ty: q.y, s: 0.4 + 0.9 * smooth(0, 0.18, q.age) - 0.1 * smooth(0.18, 0.4, q.age),
            alpha: 1 - smooth(0.75, 1, k)};
    case 'drop':
        return {tx: q.x, ty: q.y + 6 * smooth(0, 1, k), s: 0.9, alpha: a};
    default:
        return {tx: q.x + 3 * Math.sin(q.seed + q.age * 5), ty: q.y,
            s: 0.6 + 0.9 * smooth(0, 0.25, k), alpha: a};
    }
}

export function drawParticle(cr, kind, q) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    switch (kind) {
    case 'z':
        cr.setLineWidth(2.2);
        src(cr, WHITE);
        path(cr, ZED);
        cr.stroke();
        break;
    case 'clod':
        cr.newPath();
        cr.moveTo(-4.5, -1);
        cr.curveTo(-4, -4.5, 1, -5.2, 3.8, -2.8);
        cr.curveTo(6, -0.6, 4.6, 3.8, 0.8, 4.2);
        cr.curveTo(-2.8, 4.6, -5, 2, -4.5, -1);
        cr.closePath();
        cr.setSource(radial(-1.5, -2, 0.5, 0, 0, 6, [[0, DIRT], [1, DIRT_SH]]));
        cr.fill();
        break;
    case 'pkt': {
        const c = q?.down ? hex('#f2fff6') : hex('#5bf08a');
        cr.setSource(radial(0, 0, 0, 0, 0, 7, [[0, c, 1], [0.35, c, 0.85], [1, c, 0]]));
        cr.newPath();
        ellipse(cr, 0, 0, 7);
        cr.fill();
        break;
    }
    case 'star':
        drawStar(cr, 0, 0, 6, 2.6);
        src(cr, STAR);
        cr.fillPreserve();
        src(cr, mix(STAR, BLACK, 0.35), 0.8);
        cr.setLineWidth(0.8);
        cr.stroke();
        break;
    case 'spark':
        drawStar(cr, 0, 0, 6.5, 1.3, 4);
        src(cr, hex('#fffbe0'));
        cr.fill();
        break;
    case 'bang':
        cr.newPath();
        cr.moveTo(-3.8, -12);
        cr.lineTo(3.8, -12);
        cr.lineTo(2, 4);
        cr.lineTo(-2, 4);
        cr.closePath();
        ellipse(cr, 0, 9.5, 2.8);
        src(cr, hex('#ffd60a'));
        cr.fillPreserve();
        src(cr, LINE, 0.6);
        cr.setLineWidth(1);
        cr.stroke();
        break;
    case 'drop':
        path(cr, DROP);
        src(cr, SWEAT);
        cr.fill();
        break;
    default:
        path(cr, HEART);
        src(cr, hex('#ff5f7e'));
        cr.fill();
    }
}

function drawStar(cr, x, y, r, inner, points = 5) {
    cr.newPath();
    for (let i = 0; i < points * 2; i++) {
        const a = -Math.PI / 2 + i * Math.PI / points;
        const rr = i % 2 ? inner : r;
        cr.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
    }
    cr.closePath();
}

// Cairo compositor for the scene; cr must be in hill units.
export function compose(cr, p, layers = SCENE) {
    for (const l of layers) {
        withXf(cr, pivotOf(l), l.xf?.(p) ?? {}, () => {
            if (l.clip) {
                cr.save();
                cr.rectangle(...l.box);
                cr.clip();
            }
            l.draw?.(cr, p);
            if (l.children)
                compose(cr, p, l.children);
            if (l.clip)
                cr.restore();
        });
    }
    if (layers === SCENE) {
        for (const q of p.particles)
            withXf(cr, null, particleXf(q), () => drawParticle(cr, q.kind, q));
    }
}

// --- layer drawings (absolute hill units) ------------------------------------------

function drawDisc(cr, p) {
    cr.newPath();
    ellipse(cr, 0, 0, 100);
    cr.setSource(pat('disc', () => radial(-18, -46, 0, 0, 0, 100,
        [[0, WHITE, 0.12], [0.7, WHITE, 0.055], [1, WHITE, 0.03]])));
    cr.fillPreserve();
    src(cr, p.color, 0.08);
    cr.fill();
}

const STARS = [[-58, -48, 1.3], [-30, -70, 1], [8, -82, 1.4], [44, -62, 1.1], [70, -30, 1.3], [-76, -14, 1],
    [30, -36, 0.9], [-40, -26, 0.8]];

function drawStars(cr) {
    for (const [x, y, r] of STARS) {
        cr.newPath();
        ellipse(cr, x, y, r);
        src(cr, WHITE, 0.55);
        cr.fill();
    }
    // a thin moon
    cr.save();
    cr.newPath();
    ellipse(cr, -52, -60, 9);
    cr.pushGroup();
    src(cr, hex('#fff2c6'), 0.85);
    cr.fill();
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.newPath();
    ellipse(cr, -48, -63, 8.4);
    cr.fill();
    cr.popGroupToSource();
    cr.paint();
    cr.restore();
}

// A closed ring once the tunnel is up; a short spinning arc while digging.
function drawRing(cr, p) {
    const c = p.color;
    cr.setLineWidth(RING_W);
    cr.setLineCap(Cairo.LineCap.ROUND);
    src(cr, c, 0.17);
    cr.newPath();
    cr.arc(0, 0, RING_R, 0, TAU);
    cr.stroke();
    const v = p.ring.sweep;
    if (v <= 0.002)
        return;
    const bright = mix(c, WHITE, 0.25 + 0.35 * p.ring.flare);
    const deep = mix(c, BLACK, 0.12);
    const a0 = -Math.PI / 2;
    if (v >= 0.999) {
        src(cr, mix(c, WHITE, 0.08 + 0.4 * p.ring.flare));
        cr.newPath();
        cr.arc(0, 0, RING_R, 0, TAU);
        cr.stroke();
        return;
    }
    cr.setSource(conicLike(a0, a0 + v * TAU, deep, bright));
    cr.newPath();
    cr.arc(0, 0, RING_R, a0, a0 + v * TAU);
    cr.stroke();
    const end = a0 + v * TAU;
    cr.newPath();
    ellipse(cr, RING_R * Math.cos(end), RING_R * Math.sin(end), RING_W * 0.28);
    src(cr, WHITE, 0.4);
    cr.fill();
}

// Cairo has no conic gradient: a linear gradient along the chord from the
// tail to the head of the arc reads as one.
function conicLike(a0, a1, c0, c1) {
    return linear(RING_R * Math.cos(a0), RING_R * Math.sin(a0),
        RING_R * Math.cos(a1), RING_R * Math.sin(a1), [[0, c0, 0.4], [1, c1]]);
}

function drawGround(cr) {
    cr.save();
    cr.newPath();
    ellipse(cr, 0, 0, 100);
    cr.clip();

    // far hills
    path(cr, 'M -104 18 C -78 4 -52 8 -30 15 C -6 4 30 -2 60 6 C 80 11 94 8 104 4 L 104 104 L -104 104 Z');
    src(cr, BLACK, 0.16);
    cr.fill();

    // the mound
    cr.newPath();
    ellipse(cr, 0, MOUND.y, MOUND.rx, MOUND.ry);
    cr.setSource(pat('soil', () => linear(0, 18, 0, 100,
        [[0, SOIL_TOP], [0.35, SOIL], [1, SOIL_DEEP]])));
    cr.fill();
    // light on its crest
    cr.save();
    cr.newPath();
    ellipse(cr, 0, MOUND.y, MOUND.rx, MOUND.ry);
    cr.clip();
    cr.newPath();
    ellipse(cr, 0, MOUND.y - 3, MOUND.rx, MOUND.ry);
    cr.setLineWidth(5);
    src(cr, WHITE, 0.08);
    cr.stroke();
    cr.restore();

    // pebbles and roots
    for (const [x, y, rx, ry, a] of [[-62, 60, 4.2, 2.6, 0.22], [50, 70, 5, 3, 0.2], [-22, 80, 3.2, 2, 0.18],
        [78, 52, 3, 2, 0.2], [-84, 48, 2.6, 1.7, 0.16], [14, 92, 4, 2.4, 0.14], [-46, 88, 2.4, 1.5, 0.14]]) {
        cr.newPath();
        ellipse(cr, x, y, rx, ry);
        src(cr, BLACK, a);
        cr.fill();
        cr.newPath();
        ellipse(cr, x - rx * 0.25, y - ry * 0.35, rx * 0.5, ry * 0.35);
        src(cr, WHITE, 0.07);
        cr.fill();
    }
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(1.4);
    src(cr, BLACK, 0.16);
    path(cr, 'M -96 66 C -82 70 -76 64 -66 72 C -60 77 -56 76 -50 80');
    cr.stroke();
    path(cr, 'M 92 76 C 82 74 78 82 68 84');
    cr.stroke();

    // grass on the crest
    cr.setLineWidth(1.7);
    for (const x of [-86, -62, -36, 34, 88]) {
        const y = surfaceY(x) + 1.5;
        src(cr, GRASS, 0.9);
        for (const [dx, h, lean] of [[-2.2, 6, -2.4], [0, 8.5, 0.6], [2.2, 5.5, 2.6]]) {
            cr.newPath();
            cr.moveTo(x + dx, y);
            cr.curveTo(x + dx, y - h * 0.5, x + dx + lean * 0.5, y - h * 0.8, x + dx + lean, y - h);
            cr.stroke();
        }
    }

    // the dirt ring round the hole, then the hole
    cr.newPath();
    ellipse(cr, 0, RIM.y, RIM.rx, RIM.ry);
    cr.setSource(pat('rim', () => linear(0, RIM.y - RIM.ry, 0, RIM.y + RIM.ry, [[0, DIRT], [1, DIRT_SH]])));
    cr.fill();
    cr.newPath();
    ellipse(cr, 0, HOLE.y, HOLE.rx, HOLE.ry);
    cr.setSource(pat('hole', () => linear(0, HOLE.y - HOLE.ry, 0, HOLE.y + HOLE.ry,
        [[0, SOIL_DEEP], [0.35, HOLE_DARK], [1, HOLE_DARK]])));
    cr.fill();
    cr.restore();
}

// Darkness at the bottom of the hole, over whatever is in it.
function drawShade(cr) {
    cr.save();
    cr.newPath();
    ellipse(cr, 0, HOLE.y, HOLE.rx + 2, HOLE.ry + 6);
    cr.clip();
    cr.setSource(pat('shade', () => linear(0, 22, 0, CLIP_Y, [[0, HOLE_DARK, 0], [0.55, HOLE_DARK, 0.55], [1, HOLE_DARK, 0.95]])));
    cr.rectangle(-46, 18, 92, 22);
    cr.fill();
    cr.restore();
}

// The front lip of the hole, in front of the mole.
function drawLip(cr) {
    cr.newPath();
    cr.save();
    cr.translate(0, RIM.y);
    cr.scale(RIM.rx, RIM.ry);
    cr.arc(0, 0, 1, 0, Math.PI);
    cr.restore();
    cr.save();
    cr.translate(0, HOLE.y);
    cr.scale(HOLE.rx, HOLE.ry);
    cr.arcNegative(0, 0, 1, Math.PI, 0);
    cr.restore();
    cr.closePath();
    cr.setSource(pat('lip', () => linear(0, HOLE.y, 0, RIM.y + RIM.ry, [[0, mix(DIRT, WHITE, 0.12)], [0.4, DIRT], [1, DIRT_SH]])));
    cr.fill();
    // the edge catches the light
    cr.save();
    cr.translate(0, HOLE.y);
    cr.scale(HOLE.rx, HOLE.ry);
    cr.newPath();
    cr.arc(0, 0, 1, 0.15, Math.PI - 0.15);
    cr.restore();
    cr.setLineWidth(1.6);
    cr.setLineCap(Cairo.LineCap.ROUND);
    src(cr, WHITE, 0.22);
    cr.stroke();
    // crumbs on the lip
    for (const [x, y, r] of [[-30, 44, 2.2], [-14, 47.5, 1.6], [22, 46.5, 2], [38, 41, 1.5], [4, 48.5, 1.3]]) {
        cr.newPath();
        ellipse(cr, x, y, r, r * 0.75);
        src(cr, DIRT_SH, 0.9);
        cr.fill();
    }
}

function drawBody(cr) {
    path(cr, BODY);
    cr.setSource(pat('fur', () => radial(-14, -26, 4, 0, 6, 70, [[0, FUR_HI], [0.45, FUR], [1, FUR_SH]])));
    cr.fillPreserve();
    src(cr, LINE, 0.5);
    cr.setLineWidth(1.6);
    cr.stroke();
    // velvet sheen on the crown and the shoulders
    cr.save();
    path(cr, BODY);
    cr.clip();
    cr.newPath();
    ellipse(cr, -12, -36, 16, 9);
    src(cr, WHITE, 0.08);
    cr.fill();
    cr.newPath();
    ellipse(cr, 0, 34, 24, 30);
    cr.setSource(pat('belly', () => radial(0, 22, 2, 0, 34, 30, [[0, FUR_HI, 0.55], [1, FUR_HI, 0]])));
    cr.fill();
    cr.restore();
}

function drawMuzzle(cr) {
    // cheeks
    mirrored(cr, () => {
        cr.newPath();
        ellipse(cr, -21.5, -6, 5.6, 3.4);
        src(cr, hex('#ff8fa8'), 0.32);
        cr.fill();
    });
    cr.newPath();
    ellipse(cr, 0, -4.5, 16.5, 12);
    cr.setSource(pat('muzzle', () => radial(-3, -9, 2, 0, -4, 17, [[0, mix(MUZZLE, WHITE, 0.25)], [0.6, MUZZLE], [1, MUZZLE_SH]])));
    cr.fill();
    // whiskers
    cr.setLineWidth(0.8);
    cr.setLineCap(Cairo.LineCap.ROUND);
    src(cr, WHITE, 0.4);
    mirrored(cr, () => {
        for (const [x1, y1, x2, y2] of [[-11, -7, -27, -12], [-11, -5, -29, -5.5], [-11, -3, -26, 1]]) {
            cr.newPath();
            cr.moveTo(x1, y1);
            cr.lineTo(x2, y2);
            cr.stroke();
        }
    });
}

function drawNose(cr) {
    cr.newPath();
    ellipse(cr, 0, -10, 8, 6.2);
    cr.setSource(pat('nose', () => radial(-2.5, -12.5, 0.5, 0, -10, 8.5, [[0, NOSE_HI], [0.45, NOSE], [1, NOSE_SH]])));
    cr.fillPreserve();
    src(cr, LINE, 0.35);
    cr.setLineWidth(0.9);
    cr.stroke();
    mirrored(cr, () => {
        cr.newPath();
        ellipse(cr, -2.7, -8.8, 1.1, 1.3);
        src(cr, NOSE_SH, 0.9);
        cr.fill();
    });
    cr.newPath();
    ellipse(cr, -2.6, -12.6, 2.1, 1.3);
    src(cr, WHITE, 0.75);
    cr.fill();
}

function drawMouth(cr, p) {
    const open = p.mouth;
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    if (open > 0.15) {
        cr.newPath();
        ellipse(cr, 0, 1.6, 3.6, 1 + 2.6 * open);
        src(cr, hex('#5b1f2c'));
        cr.fill();
        cr.newPath();
        ellipse(cr, 0, 1.6 + 1.6 * open, 2.4, 1.2 * open);
        src(cr, hex('#ef7c90'));
        cr.fill();
    }
    // two buck teeth under the nose
    for (const x of [-1.85, 0.05]) {
        cr.newPath();
        cr.rectangle(x, -1.5, 1.8, 3.4);
        src(cr, WHITE);
        cr.fillPreserve();
        src(cr, LINE, 0.4);
        cr.setLineWidth(0.5);
        cr.stroke();
    }
    cr.newPath();
    cr.moveTo(-4.8, -1.4);
    cr.curveTo(-3.4, 0.4, -1.2, 0.2, 0, -1.6);
    cr.curveTo(1.2, 0.2, 3.4, 0.4, 4.8, -1.4);
    src(cr, LINE, 0.85);
    cr.setLineWidth(1.2);
    cr.stroke();
}

function drawEyes(cr, p) {
    const e = p.eyes;
    const lx = p.look.x * 1.5, ly = p.look.y * 1.2;
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    for (const side of [-1, 1]) {
        const x = side * 12.5 + lx, y = -19 + ly;
        cr.setLineWidth(1.7);
        src(cr, EYE);
        if (e.dizzy > 0.5) {
            // spirals
            cr.newPath();
            for (let a = 0; a < TAU * 1.6; a += 0.3) {
                const r = 0.4 + a * 0.33;
                cr.lineTo(x + r * Math.cos(a * side + p.t * 6), y + r * Math.sin(a * side + p.t * 6));
            }
            cr.setLineWidth(1.2);
            cr.stroke();
        } else if (e.squint > 0.5) {
            // > <, pushing hard
            cr.newPath();
            cr.moveTo(x - side * 3, y - 2.6);
            cr.lineTo(x + side * 2.2, y);
            cr.lineTo(x - side * 3, y + 2.6);
            cr.stroke();
        } else if (e.happy > 0.5) {
            cr.newPath();
            cr.moveTo(x - 3.2, y + 1.2);
            cr.curveTo(x - 1.6, y - 2.6, x + 1.6, y - 2.6, x + 3.2, y + 1.2);
            cr.stroke();
        } else if (e.open < 0.2) {
            // asleep: a soft arc
            cr.newPath();
            cr.moveTo(x - 3.2, y);
            cr.curveTo(x - 1.6, y + 2.4, x + 1.6, y + 2.4, x + 3.2, y);
            cr.stroke();
        } else {
            cr.newPath();
            ellipse(cr, x, y, 2.9, 3.6 * e.open);
            cr.fill();
            cr.newPath();
            ellipse(cr, x - 0.9, y - 1.3 * e.open, 1.1, 1.1 * e.open);
            src(cr, WHITE, 0.95);
            cr.fill();
        }
        if (e.worry > 0.05) {
            cr.newPath();
            cr.moveTo(x - side * 4.2, y - 5.6);
            cr.lineTo(x + side * 2.6, y - 8.2);
            src(cr, EYE, e.worry * 0.9);
            cr.setLineWidth(1.4);
            cr.stroke();
        }
    }
}

function drawHelmet(cr) {
    // the brim, underside first
    cr.newPath();
    ellipse(cr, 0, -34, 37, 6.6);
    src(cr, HELMET_DEEP);
    cr.fill();
    path(cr, DOME);
    cr.setSource(pat('dome', () => radial(-12, -62, 2, 0, -46, 40, [[0, HELMET_HI], [0.45, HELMET], [1, HELMET_SH]])));
    cr.fillPreserve();
    src(cr, HELMET_DEEP, 0.7);
    cr.setLineWidth(1.3);
    cr.stroke();
    path(cr, RIDGE);
    cr.setSource(pat('ridge', () => linear(-5, 0, 5, 0, [[0, HELMET_SH], [0.5, HELMET_HI], [1, HELMET_SH]])));
    cr.fill();
    cr.newPath();
    ellipse(cr, 0, -35.6, 36, 5.2);
    cr.setSource(pat('brim', () => linear(0, -41, 0, -30, [[0, HELMET_HI], [1, HELMET]])));
    cr.fillPreserve();
    src(cr, HELMET_DEEP, 0.7);
    cr.setLineWidth(1.1);
    cr.stroke();
    // shine
    cr.newPath();
    ellipse(cr, -14, -60, 6, 3.4);
    src(cr, WHITE, 0.45);
    cr.fill();
}

function drawLamp(cr, p) {
    const [x, y] = LAMP;
    const on = p.lamp.on, c = p.lamp.color;
    if (on > 0.02) {
        cr.setSource(radial(x, y, 2, x, y, 28, [[0, c, 0.55 * on], [0.4, c, 0.18 * on], [1, c, 0]]));
        cr.newPath();
        ellipse(cr, x, y, 28);
        cr.fill();
    }
    cr.newPath();
    ellipse(cr, x, y, 9);
    cr.setSource(radial(x - 2, y - 3, 1, x, y, 9.5, [[0, hex('#7a7a86')], [1, RIM_METAL]]));
    cr.fill();
    cr.newPath();
    ellipse(cr, x, y, 6.3);
    const glass = mix(hex('#2c2c35'), c, on);
    cr.setSource(radial(x - 1.5, y - 1.8, 0.5, x, y, 6.5, [[0, mix(glass, WHITE, 0.25 + 0.6 * on)], [0.6, glass], [1, mix(glass, BLACK, 0.25)]]));
    cr.fill();
    cr.newPath();
    ellipse(cr, x - 2.1, y - 2.4, 1.7, 1.1);
    src(cr, WHITE, 0.7);
    cr.fill();
}

// A cone of light from the helmet lamp, up and out.
function drawBeam(cr, p) {
    const [x, y] = LAMP;
    const c = p.lamp.color;
    const ang = -1.05, half = 0.26, len = 76;
    cr.newPath();
    cr.moveTo(x + 6 * Math.cos(ang - Math.PI / 2), y + 6 * Math.sin(ang - Math.PI / 2));
    cr.lineTo(x + len * Math.cos(ang - half), y + len * Math.sin(ang - half));
    cr.lineTo(x + len * Math.cos(ang + half), y + len * Math.sin(ang + half));
    cr.lineTo(x + 6 * Math.cos(ang + Math.PI / 2), y + 6 * Math.sin(ang + Math.PI / 2));
    cr.closePath();
    cr.setSource(radial(x, y, 4, x, y, len, [[0, c, 0.36], [0.45, c, 0.13], [1, c, 0]]));
    cr.fill();
}

function drawPaw(cr, side) {
    cr.save();
    cr.scale(side, 1);
    // left paw, mirrored for the right one
    cr.save();
    cr.translate(-29, 24.5);
    cr.rotate(-0.28);
    cr.newPath();
    ellipse(cr, 0, 0, 12.5, 8.6);
    cr.setSource(pat('paw', () => radial(-3, -3, 1, 0, 0, 13, [[0, mix(PAW, WHITE, 0.25)], [0.6, PAW], [1, PAW_SH]])));
    cr.fillPreserve();
    src(cr, LINE, 0.45);
    cr.setLineWidth(1.1);
    cr.stroke();
    // four claws, fanned
    for (const [cx, tilt] of [[-8.5, -0.32], [-3, -0.1], [2.5, 0.1], [7.8, 0.32]]) {
        cr.save();
        cr.translate(cx, 6.2);
        cr.rotate(tilt);
        cr.newPath();
        cr.moveTo(-2.3, 0);
        cr.curveTo(-2.3, 3.6, -0.9, 6.4, 0, 7.4);
        cr.curveTo(0.9, 6.4, 2.3, 3.6, 2.3, 0);
        cr.closePath();
        src(cr, CLAW);
        cr.fillPreserve();
        src(cr, CLAW_SH, 0.9);
        cr.setLineWidth(0.7);
        cr.stroke();
        cr.restore();
    }
    // pad lines
    cr.setLineWidth(0.8);
    src(cr, PAW_SH, 0.7);
    for (const cx of [-4.5, 0.5, 5.2]) {
        cr.newPath();
        cr.moveTo(cx, 1.5);
        cr.lineTo(cx + 0.3, 5);
        cr.stroke();
    }
    cr.restore();
    cr.restore();
}

// A flag of the server's country on a little pole. The real flag when the
// emoji font has it, else a pennant with the country code.
function drawFlag(cr, p) {
    const code = p.flag.code;
    const [bx, by] = FLAG_BASE;
    const top = by - 50;
    // a mound of fresh dirt round the pole
    cr.newPath();
    ellipse(cr, bx, by + 0.5, 7, 2.6);
    src(cr, DIRT_SH);
    cr.fill();
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(2.4);
    cr.setSource(linear(bx - 1.2, 0, bx + 1.2, 0, [[0, mix(POLE, BLACK, 0.25)], [0.5, POLE], [1, mix(POLE, BLACK, 0.3)]]));
    cr.newPath();
    cr.moveTo(bx, by);
    cr.lineTo(bx, top);
    cr.stroke();
    cr.newPath();
    ellipse(cr, bx, top - 1, 2.2);
    src(cr, hex('#ffd60a'));
    cr.fill();
    if (!code)
        return;
    const layout = PangoCairo.create_layout(cr);
    const font = Pango.FontDescription.from_string('Noto Color Emoji');
    font.set_absolute_size(17 * Pango.SCALE);
    layout.set_font_description(font);
    layout.set_text(flagEmoji(code), -1);
    if (flagEmoji(code) && layout.get_unknown_glyphs_count() === 0) {
        const [, logical] = layout.get_pixel_extents();
        cr.save();
        cr.moveTo(bx + 1.2, top + 1 - logical.height * 0.18);
        PangoCairo.show_layout(cr, layout);
        cr.restore();
        return;
    }
    // pennant
    cr.newPath();
    cr.moveTo(bx + 1, top);
    cr.lineTo(bx + 27, top + 7);
    cr.lineTo(bx + 1, top + 14);
    cr.closePath();
    src(cr, WHITE);
    cr.fill();
    const label = PangoCairo.create_layout(cr);
    const small = Pango.FontDescription.from_string('Sans Bold');
    small.set_absolute_size(7 * Pango.SCALE);
    label.set_font_description(small);
    label.set_text(code, -1);
    const [, ext] = label.get_pixel_extents();
    cr.moveTo(bx + 3, top + 7 - ext.height / 2);
    src(cr, LINE);
    PangoCairo.show_layout(cr, label);
}

// --- the panel glyph -----------------------------------------------------------------

export const GLYPH = {w: 22, h: 22};

const G_DOME = 'M 3.6 15 C 3.6 8.6 7.1 4.6 11 4.6 C 14.9 4.6 18.4 8.6 18.4 15 Z';
const G_LAMP = [11, 10.3, 3.25];

// A miner's helmet in the panel colour; the lamp tells the state.
// g: {lamp: rgb, on: 0..1, dim: 0..1, scale, dy, roll, pending: 0..1}
export function drawGlyph(cr, fg, g) {
    cr.save();
    cr.translate(11, 13 + (g.dy ?? 0));
    cr.scale(g.scale ?? 1, g.scale ?? 1);
    cr.rotate(g.roll ?? 0);
    cr.translate(-11, -13);
    const [lx, ly, lr] = G_LAMP;
    const on = clamp(g.on ?? 0, 0, 1);

    cr.pushGroup();
    src(cr, fg);
    path(cr, G_DOME);
    cr.fill();
    cr.newPath();
    const rr = 1.5;
    cr.arc(1.8 + rr, 14.4 + rr, rr, Math.PI, 1.5 * Math.PI);
    cr.arc(20.2 - rr, 14.4 + rr, rr, 1.5 * Math.PI, 0);
    cr.arc(20.2 - rr, 17.6 - rr, rr, 0, Math.PI / 2);
    cr.arc(1.8 + rr, 17.6 - rr, rr, Math.PI / 2, Math.PI);
    cr.closePath();
    cr.fill();
    // the lamp housing is cut out of the dome
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.newPath();
    ellipse(cr, lx, ly, lr + 1.05);
    cr.fill();
    cr.setOperator(Cairo.Operator.OVER);
    // a thin ring of the helmet stays round the lamp
    cr.newPath();
    ellipse(cr, lx, ly, lr + 0.35);
    cr.setLineWidth(0.7);
    src(cr, fg);
    cr.stroke();
    cr.popGroupToSource();
    cr.paintWithAlpha((fg[3] ?? 1) * (1 - 0.45 * clamp(g.dim ?? 0, 0, 1)));

    // the lamp: lit in the state colour, or dark glass
    if (on > 0.02) {
        cr.setSource(radial(lx, ly, 0, lx, ly, lr * 2.3, [[0, g.lamp, 0.45 * on], [1, g.lamp, 0]]));
        cr.newPath();
        ellipse(cr, lx, ly, lr * 2.3);
        cr.fill();
    }
    cr.newPath();
    ellipse(cr, lx, ly, lr);
    src(cr, mix(fg.slice(0, 3), g.lamp, on), on > 0.02 ? 1 : 0.35 * (fg[3] ?? 1));
    cr.fill();

    // waiting to switch off: a little clock in the corner
    const pend = clamp(g.pending ?? 0, 0, 1);
    if (pend > 0.02) {
        const cx = 18.6, cy = 18.4, r = 3.1 * pend;
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.newPath();
        ellipse(cr, cx, cy, r + 1);
        cr.fill();
        cr.setOperator(Cairo.Operator.OVER);
        cr.newPath();
        ellipse(cr, cx, cy, r);
        src(cr, fg);
        cr.fill();
        cr.setLineWidth(0.8);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.newPath();
        cr.moveTo(cx, cy - r * 0.62);
        cr.lineTo(cx, cy);
        cr.lineTo(cx + r * 0.45, cy + r * 0.25);
        cr.stroke();
        cr.setOperator(Cairo.Operator.OVER);
    }
    cr.restore();
}
