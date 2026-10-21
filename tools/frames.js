// Renders the mole in each state to a contact sheet, with plain gjs:
//   gjs -m tools/frames.js out.png [scale]
// Handy for checking drawings without restarting the Shell.

import Cairo from 'cairo';
import System from 'system';

import {HERO, Mole, compose} from '../psiphon-tunnel@terentiy/mole.js';

const [out = 'frames.png', scaleArg = '2'] = ARGV;
const K = Number(scaleArg);

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

const busy = {down: 900000, up: 120000};

// [label, first state, then state, seconds to run, optional action]
const SHOTS = [
    ['off', {state: 'off'}, null, 3],
    ['poked awake', {state: 'off'}, null, 1, m => m.poke(), 0.9],
    ['connecting', {state: 'off'}, {state: 'connecting'}, 1.6],
    ['on', {state: 'off'}, {state: 'on', region: 'NL', traffic: busy}, 2.4],
    ['on, happy', {state: 'on', region: 'DE', traffic: busy}, null, 2, m => m.poke(), 0.35],
    ['reconnecting', {state: 'on', region: 'FI'}, {state: 'reconnecting', region: 'FI'}, 2.2],
    ['stopping', {state: 'on', region: 'NL'}, {state: 'stopping', region: 'NL'}, 0.5],
    ['off again', {state: 'on', region: 'NL'}, {state: 'off'}, 3],
    ['failed', {state: 'connecting'}, {state: 'failed'}, 1.5],
    ['no emoji', {state: 'on', region: 'ZZ'}, null, 1.5],
];

const CELL_W = HERO.w * HERO.scale, CELL_H = HERO.h * HERO.scale;
const cols = 5;
const rows = Math.ceil(SHOTS.length / cols);
const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.ceil(cols * CELL_W * K), Math.ceil(rows * CELL_H * K));
const cr = new Cairo.Context(surf);
cr.setSourceRGB(29 / 255, 30 / 255, 37 / 255);
cr.paint();

SHOTS.forEach(([label, first, then, secs, action, after = 0], i) => {
    const m = new Mole({random: rng(7 + i)});
    m.update(first);
    m.intro();
    for (let t = 0; t < 1.5; t += 1 / 60)
        m.step(1 / 60);
    if (then)
        m.update(then);
    for (let t = 0; t < secs; t += 1 / 60)
        m.step(1 / 60);
    if (action) {
        action(m);
        for (let t = 0; t < after; t += 1 / 60)
            m.step(1 / 60);
    }
    cr.save();
    cr.translate((i % cols) * CELL_W * K, Math.floor(i / cols) * CELL_H * K);
    cr.scale(K * HERO.scale, K * HERO.scale);
    cr.translate(-HERO.x0, -HERO.y0);
    compose(cr, m.pose);
    cr.restore();
    cr.save();
    cr.translate((i % cols) * CELL_W * K + 8, Math.floor(i / cols) * CELL_H * K + 18);
    cr.setSourceRGBA(1, 1, 1, 0.6);
    cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
    cr.setFontSize(12 * K / 2);
    cr.showText(label);
    cr.restore();
});

surf.writeToPNG(out);
cr.$dispose();
System.exit(0);
