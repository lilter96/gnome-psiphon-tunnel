// gjs -m tests/run.js
import System from 'system';
import {run} from './harness.js';
import './tunnel.test.js';
import './settings.test.js';
import './process.test.js';
import './psi.test.js';
import './install.test.js';

System.exit(await run() ? 1 : 0);
