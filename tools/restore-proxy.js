// install.sh --uninstall: puts the GNOME system proxy back from the
// extension's state.json, when no running extension did it on the way out.
// A proxy someone changed since is left as it is, like the extension does.
//
//   gjs -m tools/restore-proxy.js <state.json>
import GLib from 'gi://GLib';

import {SystemProxy} from '../psiphon-tunnel@terentiy/proxy.js';

const [path] = ARGV;
let state = null;
try {
    state = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
} catch {}
if (state?.proxy) {
    print(new SystemProxy().restore(state.proxy) ? 'put back' : 'changed since, left as it is');
    state.proxy = null;
    GLib.file_set_contents(path, JSON.stringify(state));
}
