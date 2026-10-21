// gjs -m tools/icon.js — the notification icon: the mole with its lamp on, on graphite.
import Cairo from 'cairo';
import System from 'system';
import {roundRect, src} from '../psiphon-tunnel@terentiy/kit.js';
import {Mole, compose} from '../psiphon-tunnel@terentiy/mole.js';

const S = 128;
const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, S, S);
const cr = new Cairo.Context(surf);
roundRect(cr, 0, 0, S, S, 30);
cr.clip();
src(cr, [0.114, 0.118, 0.145]);
cr.paint();

const mole = new Mole({random: () => 0.5, reducedMotion: true});
mole.update({state: 'on', region: null});
mole.settle();
const pose = {...mole.pose, particles: [], beam: {...mole.pose.beam, alpha: 0}};
// the head and the hole fill the square
const k = S / 124;
cr.scale(k, k);
cr.translate(62, 84);
compose(cr, pose);
surf.writeToPNG(ARGV[0] ?? 'psiphon-tunnel@terentiy/icons/mole.png');
System.exit(0);
