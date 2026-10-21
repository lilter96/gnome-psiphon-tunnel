// gjs -m tools/glyph.js out.png — the panel glyph in each state, zoomed, on a
// dark and a light panel.
import Cairo from 'cairo';
import System from 'system';
import {GLYPH, LOOKS, drawGlyph} from '../psiphon-tunnel@terentiy/mole.js';

const Z = 6;
const states = [
    {lamp: LOOKS.off.color, on: 0, dim: 1},
    {lamp: LOOKS.connecting.color, on: 1, dim: 0},
    {lamp: LOOKS.connecting.color, on: 0.25, dim: 0},
    {lamp: LOOKS.on.color, on: 1, dim: 0},
    {lamp: LOOKS.on.color, on: 1, dim: 0, pending: 1},
    {lamp: LOOKS.failed.color, on: 1, dim: 0, roll: 0.15},
];
const W = GLYPH.w * Z + 20, H = GLYPH.h * Z + 20;
const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, W * states.length, (H + 40) * 2);
const cr = new Cairo.Context(surf);
for (const [band, bg, fg] of [[0, [0, 0, 0], [1, 1, 1, 1]], [1, [0.96, 0.96, 0.96], [0.12, 0.12, 0.12, 1]]]) {
    const y0 = band * (H + 40);
    cr.setSourceRGB(...bg);
    cr.rectangle(0, y0, W * states.length, H + 40);
    cr.fill();
    states.forEach((g, i) => {
        for (const [row, k] of [[0, Z], [1, 1]]) {
            cr.save();
            cr.translate(i * W + 10, y0 + (row ? H + 8 : 6));
            cr.scale(k, k);
            // in its own layer, as in the panel: cut-outs show what is behind
            cr.pushGroup();
            drawGlyph(cr, fg, g);
            cr.popGroupToSource();
            cr.paint();
            cr.restore();
        }
    });
}
surf.writeToPNG(ARGV[0] ?? 'glyph.png');
System.exit(0);
