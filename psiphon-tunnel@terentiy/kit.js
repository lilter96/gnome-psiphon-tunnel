// Drawing and motion toolkit shared by Roshan, the charts and the panel glyph:
// springs, OKLCH colour, a small SVG path parser and a layer compositor.
// No Shell imports, so everything here also runs under plain gjs.

import Cairo from 'cairo';

export const TAU = 2 * Math.PI;

export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export const lerp = (a, b, t) => a + (b - a) * t;
export const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
};

export const WHITE = [1, 1, 1];
export const BLACK = [0, 0, 0];

// --- colour ------------------------------------------------------------------

// Mood colours animate in OKLCH, the short way round the hue circle: green
// turns red through yellow and orange, not through brown.
const toLinear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const toGamma = v => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

export function toOklch(rgb) {
    const [r, g, b] = rgb.map(toLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q;
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q, Math.hypot(A, B), Math.atan2(B, A)];
}

export function fromOklch([L, C, h]) {
    const A = C * Math.cos(h), B = C * Math.sin(h);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const q = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q,
        -0.0041960863 * l - 0.7034186453 * m + 1.7076147010 * q,
    ].map(v => toGamma(clamp(v, 0, 1)));
}

// A colour made of three springs [L, C, h].
export class ColorSpring {
    constructor(rgb, response = 0.9) {
        const [l, c, h] = toOklch(rgb);
        this.L = new Spring(l, response);
        this.C = new Spring(c, response);
        this.h = new Spring(h, response);
    }

    to(rgb, snap = false) {
        const [l, c, hue] = toOklch(rgb);
        const near = hue + TAU * Math.round((this.h.x - hue) / TAU);
        for (const [sp, v] of [[this.L, l], [this.C, c], [this.h, near]]) {
            if (snap)
                sp.snap(v);
            else
                sp.to(v);
        }
    }

    step(dt) {
        this.L.step(dt);
        this.C.step(dt);
        this.h.step(dt);
    }

    get resting() {
        return this.L.resting && this.C.resting && this.h.resting;
    }

    get rgb() {
        return fromOklch([this.L.x, this.C.x, this.h.x]);
    }
}

// --- springs -------------------------------------------------------------------

// SwiftUI-style spring: `response` is the period of the undamped oscillation in
// seconds, `damping` the damping fraction (1 = critical, < 1 bounces).
export class Spring {
    constructor(x, response = 0.5, damping = 1) {
        this.x = x;
        this.v = 0;
        this.target = x;
        this.tune(response, damping);
    }

    tune(response, damping = 1) {
        this.k = (TAU / response) ** 2;
        this.c = 4 * Math.PI * damping / response;
        return this;
    }

    to(target) {
        this.target = target;
        return this;
    }

    snap(x) {
        this.x = this.target = x;
        this.v = 0;
    }

    // Restart from x, keeping the target.
    from(x) {
        this.x = x;
        this.v = 0;
        return this;
    }

    kick(v) {
        this.v += v;
    }

    step(dt) {
        const n = Math.ceil(dt * 240);
        const h = dt / n;
        for (let i = 0; i < n; i++) {
            this.v += (-this.k * (this.x - this.target) - this.c * this.v) * h;
            this.x += this.v * h;
        }
    }

    get resting() {
        return Math.abs(this.x - this.target) < 1e-3 && Math.abs(this.v) < 1e-2;
    }
}

// --- cairo helpers -------------------------------------------------------------

export function src(cr, c, a = 1) {
    cr.setSourceRGBA(c[0], c[1], c[2], a * (c[3] ?? 1));
}

function stops(p, list) {
    for (const [o, c, a = 1] of list)
        p.addColorStopRGBA(o, c[0], c[1], c[2], a);
    return p;
}

export const linear = (x0, y0, x1, y1, list) => stops(new Cairo.LinearGradient(x0, y0, x1, y1), list);
export const radial = (x0, y0, r0, x1, y1, r1, list) =>
    stops(new Cairo.RadialGradient(x0, y0, r0, x1, y1, r1), list);

// Static patterns live in fixed (layer-local) coordinates, build them once.
const PAT = new Map();
export function pat(name, make) {
    let p = PAT.get(name);
    if (!p) {
        p = make();
        PAT.set(name, p);
    }
    return p;
}

const parsed = new Map();

// A small SVG path-data subset: M L H V C Q Z, absolute and relative.
function parse(d) {
    let out = parsed.get(d);
    if (out)
        return out;
    out = [];
    const tok = d.match(/[MLHVCQZmlhvcqz]|-?(?:\d+\.?\d*|\.\d+)/g);
    let i = 0, cmd = 'M', x = 0, y = 0, sx = 0, sy = 0;
    const num = () => parseFloat(tok[i++]);
    while (i < tok.length) {
        if (/[A-Za-z]/.test(tok[i]))
            cmd = tok[i++];
        const rel = cmd === cmd.toLowerCase();
        const ox = rel ? x : 0, oy = rel ? y : 0;
        switch (cmd.toUpperCase()) {
        case 'M':
            x = ox + num(); y = oy + num();
            sx = x; sy = y;
            out.push([0, x, y]);
            cmd = rel ? 'l' : 'L';
            break;
        case 'L':
            x = ox + num(); y = oy + num();
            out.push([1, x, y]);
            break;
        case 'H':
            x = ox + num();
            out.push([1, x, y]);
            break;
        case 'V':
            y = oy + num();
            out.push([1, x, y]);
            break;
        case 'C': {
            const c = [ox + num(), oy + num(), ox + num(), oy + num()];
            x = ox + num(); y = oy + num();
            out.push([2, ...c, x, y]);
            break;
        }
        case 'Q': {
            const qx = ox + num(), qy = oy + num();
            const nx = ox + num(), ny = oy + num();
            out.push([2, x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y),
                nx + 2 / 3 * (qx - nx), ny + 2 / 3 * (qy - ny), nx, ny]);
            x = nx; y = ny;
            break;
        }
        case 'Z':
            out.push([3]);
            x = sx; y = sy;
            break;
        default:
            i++;
        }
    }
    parsed.set(d, out);
    return out;
}

export function path(cr, d, newPath = true) {
    if (newPath)
        cr.newPath();
    for (const c of parse(d)) {
        if (c[0] === 0)
            cr.moveTo(c[1], c[2]);
        else if (c[0] === 1)
            cr.lineTo(c[1], c[2]);
        else if (c[0] === 2)
            cr.curveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
        else
            cr.closePath();
    }
}

export function ellipse(cr, x, y, rx, ry = rx) {
    cr.save();
    cr.translate(x, y);
    cr.scale(rx, ry);
    cr.newSubPath();
    cr.arc(0, 0, 1, 0, TAU);
    cr.restore();
}

export function arcPath(cr, cx, cy, rx, ry, a0, a1) {
    cr.save();
    cr.translate(cx, cy);
    cr.scale(rx, ry);
    cr.newPath();
    cr.arc(0, 0, 1, a0, a1);
    cr.restore();
}

export function roundRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// Draw fn for the left side (-1), then mirrored for the right side (1).
export function mirrored(cr, fn) {
    fn(-1);
    cr.save();
    cr.scale(-1, 1);
    fn(1);
    cr.restore();
}

// --- layers ----------------------------------------------------------------------
//
// A scene is a tree of layers, like Core Animation: every layer is drawn once
// into its own texture and then only moved, turned, scaled or faded. A layer
// is redrawn only when its key() changes. Clutter composites the tree in the
// Shell (ui.js), compose() does the same with Cairo for tests and media.

export const qz = (v, step) => Math.round(v / step);
export const colorKey = c => c.map(v => Math.round(v * 255)).join(',');

export function withXf(cr, pivot, xf, fn) {
    const [px, py] = pivot ?? [0, 0];
    const alpha = xf.alpha ?? 1;
    if (alpha <= 0.004)
        return;
    cr.save();
    cr.translate(px + (xf.tx ?? 0), py + (xf.ty ?? 0));
    cr.rotate(xf.rot ?? 0);
    cr.scale(xf.sx ?? xf.s ?? 1, xf.sy ?? xf.s ?? 1);
    cr.translate(-px, -py);
    if (alpha < 0.996)
        cr.pushGroup();
    fn();
    if (alpha < 0.996) {
        cr.popGroupToSource();
        cr.paintWithAlpha(alpha);
    }
    cr.restore();
}

// Layers without a pivot turn about the centre of their box, as in Clutter.
export const pivotOf = l => l.pivot ?? [l.box[0] + l.box[2] / 2, l.box[1] + l.box[3] / 2];
