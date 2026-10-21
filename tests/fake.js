// A fake Psiphon in a home of its own, for the process tests and the psi
// script tests. Random ports and a temporary directory each time, so a real
// Psiphon nearby is never touched.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {busyPorts, findPsiphon, sleep} from '../psiphon-tunnel@terentiy/psiphon.js';

Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
let fake = null;

export async function compileFake() {
    if (fake)
        return fake;
    const dir = GLib.dir_make_tmp('fake-psiphon-XXXXXX');
    fake = GLib.build_filenamev([dir, 'psiphon']);
    const cc = Gio.Subprocess.new(['cc', '-O1', '-o', fake, GLib.build_filenamev([here, 'fake-psiphon.c'])],
        Gio.SubprocessFlags.NONE);
    await cc.wait_check_async(null);
    return fake;
}

export function freePorts() {
    const busy = busyPorts();
    let p = 20000 + Math.floor(Math.random() * 20000);
    while (busy.has(p) || busy.has(p + 1))
        p += 2;
    return [p, p + 1];
}

// A home of our own: ~/psiphon with the fake binary, a config and nothing else.
export async function home() {
    const bin = await compileFake();
    const root = GLib.dir_make_tmp('psiphon-tunnel-XXXXXX');
    const dir = GLib.build_filenamev([root, 'psiphon']);
    GLib.mkdir_with_parents(dir, 0o755);
    const [http, socks] = freePorts();
    const paths = {
        bin: GLib.build_filenamev([dir, 'psiphon']),
        conf: GLib.build_filenamev([dir, 'client.conf']),
        log: GLib.build_filenamev([dir, 'psiphon.log']),
        pidfile: GLib.build_filenamev([dir, 'psiphon.pid']),
        cwd: root,
    };
    Gio.File.new_for_path(bin).copy(Gio.File.new_for_path(paths.bin), Gio.FileCopyFlags.NONE, null, null);
    GLib.chmod(paths.bin, 0o755);
    GLib.file_set_contents(paths.conf, JSON.stringify({LocalHttpProxyPort: http, LocalSocksProxyPort: socks}));
    return {paths, http, socks};
}

export async function until(fn, ms = 3000) {
    const t0 = Date.now();
    while (!fn()) {
        if (Date.now() - t0 > ms)
            return false;
        await sleep(20);
    }
    return true;
}

export const read = path => {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
};

export async function userSystemd() {
    try {
        const p = Gio.Subprocess.new(['systemd-run', '--user', '--scope', '--quiet', '--collect', 'true'],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        await p.wait_check_async(null);
        return true;
    } catch {
        return false;
    }
}

export function cleanup(p) {
    for (const x of findPsiphon(p.paths))
        GLib.spawn_command_line_sync(`kill -KILL ${x.pid}`);
    p.destroy();
}
