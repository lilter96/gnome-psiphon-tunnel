// install.sh in a home of its own: the fake Psiphon and a made-up config come
// from file:// URLs with their checksums, the way the real ones come from
// GitHub. Without a session bus of its own a run never reaches dconf: only
// the last test turns the extension on, in a dbus-run-session whose dconf
// lives in the temporary home.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Psiphon} from '../psiphon-tunnel@terentiy/psiphon.js';
import {tunnelValues} from '../psiphon-tunnel@terentiy/proxy.js';
import {cleanup, compileFake, read, until} from './fake.js';
import {assert, equal, test} from './harness.js';

const UUID = 'psiphon-tunnel@terentiy';
const repo = GLib.canonicalize_filename(GLib.build_filenamev(
    [GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..']), null);
const script = GLib.build_filenamev([repo, 'install.sh']);

// The layout of the config PsiphonLinux hands out, with made-up values.
const CONF = `{
"LocalHttpProxyPort":8081,
"LocalSocksProxyPort":1081,
"EgressRegion":"US",
"PropagationChannelId":"made-up-channel",
"SponsorId":"made-up-sponsor",
"UseIndistinguishableTLS":true
}
`;

const sha256 = path => GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
    GLib.file_get_contents(path)[1]);
const mode = path => Gio.File.new_for_path(path).query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
    .get_attribute_uint32('unix::mode') & 0o777;
const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS) || GLib.file_test(path, GLib.FileTest.IS_SYMLINK);
const link = path => (GLib.file_test(path, GLib.FileTest.IS_SYMLINK) ? GLib.file_read_link(path) : null);

// A temporary home, its XDG folders, the downloads, and a gnome-extensions
// that says no, like one with no Shell to talk to.
async function sandbox() {
    const root = GLib.dir_make_tmp('pt-install-XXXXXX');
    const at = (...p) => GLib.build_filenamev([root, ...p]);
    for (const d of ['home', 'data', 'state', 'config', 'cache', 'runtime', 'dl', 'fakebin'])
        GLib.mkdir_with_parents(at(d), 0o700);
    const bin = await compileFake();
    Gio.File.new_for_path(bin).copy(Gio.File.new_for_path(at('dl', 'psiphon')), Gio.FileCopyFlags.NONE, null, null);
    GLib.file_set_contents(at('dl', 'psiphon.config'), CONF);
    GLib.file_set_contents(at('fakebin', 'gnome-extensions'), '#!/bin/sh\nexit 2\n');
    GLib.chmod(at('fakebin', 'gnome-extensions'), 0o755);
    const home = at('home');
    const psidir = GLib.build_filenamev([home, 'psiphon']);
    return {
        root, at, home, psidir,
        ext: at('data', 'gnome-shell', 'extensions', UUID),
        cmd: name => GLib.build_filenamev([home, '.local', 'bin', name]),
        paths: {
            bin: GLib.build_filenamev([psidir, 'psiphon']),
            conf: GLib.build_filenamev([psidir, 'client.conf']),
            log: GLib.build_filenamev([psidir, 'psiphon.log']),
            pidfile: GLib.build_filenamev([psidir, 'psiphon.pid']),
            cwd: home,
        },
        env: {
            HOME: home,
            XDG_DATA_HOME: at('data'),
            XDG_STATE_HOME: at('state'),
            XDG_CONFIG_HOME: at('config'),
            XDG_CACHE_HOME: at('cache'),
            XDG_RUNTIME_DIR: at('runtime'),
            PATH: `${at('fakebin')}:${GLib.getenv('PATH')}`,
            PSIPHON_BIN_URL: `file://${at('dl', 'psiphon')}`,
            PSIPHON_BIN_SHA256: sha256(at('dl', 'psiphon')),
            PSIPHON_CONF_URL: `file://${at('dl', 'psiphon.config')}`,
            PSIPHON_CONF_SHA256: sha256(at('dl', 'psiphon.config')),
            GSETTINGS_BACKEND: 'memory',
        },
    };
}

async function run(box, argv, env = {}) {
    const l = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
    for (const v of ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE'])
        l.unsetenv(v);
    for (const [k, v] of Object.entries({...box.env, ...env})) {
        if (v === null)
            l.unsetenv(k);
        else
            l.setenv(k, v, true);
    }
    l.set_cwd(box.home);
    const p = l.spawnv(argv);
    const [out, err] = await p.communicate_utf8_async(null, null);
    return {status: p.get_exit_status(), out, err};
}

const install = (box, ...args) => run(box, ['bash', script, ...args]);

function rmrf(box) {
    cleanup(new Psiphon(box.paths, () => {}));
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(box.root)}`);
}

test('install.sh sets up Psiphon, the commands and the extension, and psi-on works right away', async () => {
    const box = await sandbox();
    try {
        const r = await install(box, '--no-enable');
        equal(r.status, 0, r.err + r.out);
        assert(/checksum verified: ~\/psiphon\/psiphon/.test(r.out), r.out);

        equal(sha256(box.paths.bin), box.env.PSIPHON_BIN_SHA256, 'the binary');
        equal(mode(box.paths.bin), 0o755);
        const conf = JSON.parse(read(box.paths.conf));
        equal(mode(box.paths.conf), 0o600, 'the config is private');
        equal(conf.EgressRegion, '', 'the fastest country');
        equal(conf.DataRootDirectory, GLib.build_filenamev([box.psidir, 'data']));
        equal(mode(conf.DataRootDirectory), 0o700);
        equal(conf.SponsorId, 'made-up-sponsor', 'the rest is kept');
        assert(conf.LocalHttpProxyPort >= 8081 && conf.LocalSocksProxyPort >= 1081, JSON.stringify(conf));
        assert(new RegExp(`HTTP proxy 127.0.0.1:${conf.LocalHttpProxyPort}, SOCKS 127.0.0.1:${conf.LocalSocksProxyPort}`)
            .test(r.out), r.out);
        assert(!/\.psiphon\.|\.client\./.test(new TextDecoder().decode(GLib.spawn_command_line_sync(`ls -a ${box.psidir}`)[1])),
            'no temporary files left');

        assert(read(box.cmd('psi')).includes("# psi-on and psi-off: Psiphon's console client"));
        equal(mode(box.cmd('psi')), 0o755);
        equal(link(box.cmd('psi-on')), 'psi');
        equal(link(box.cmd('psi-off')), 'psi');

        equal(link(box.ext), null, 'a copy, not a link');
        assert(read(GLib.build_filenamev([box.ext, 'metadata.json'])).includes(UUID));
        assert(exists(GLib.build_filenamev([box.ext, 'schemas', 'gschemas.compiled'])), 'settings compiled');
        assert(exists(GLib.build_filenamev([box.ext, 'prefs.js'])));

        const on = await run(box, [box.cmd('psi-on')]);
        equal(on.status, 0, on.err);
        assert(await until(() => /"noticeType":"Tunnels"/.test(read(box.paths.log) ?? ''), 5000), 'connected');
        const status = await run(box, [box.cmd('psi')]);
        assert(/^psiphon +running/m.test(status.out) && /^country +fastest/m.test(status.out), status.out);
        const off = await run(box, [box.cmd('psi-off')]);
        equal(off.status, 0, off.err);
    } finally {
        rmrf(box);
    }
});

test('a machine without GNOME Shell still gets Psiphon and the commands', async () => {
    const box = await sandbox();
    try {
        GLib.file_set_contents(box.at('fakebin', 'gnome-shell'), '#!/bin/sh\nexit 127\n');
        GLib.chmod(box.at('fakebin', 'gnome-shell'), 0o755);
        const r = await install(box, '--no-enable');
        equal(r.status, 0, r.err + r.out);
        assert(/GNOME Shell is not here/.test(r.out), r.out);
        assert(exists(box.paths.bin) && exists(box.cmd('psi-on')), 'installed');
    } finally {
        rmrf(box);
    }
});

test('a second run keeps your Psiphon and your config; --update-psiphon replaces the binary', async () => {
    const box = await sandbox();
    try {
        equal((await install(box, '--no-enable')).status, 0);
        GLib.file_set_contents(box.paths.conf, read(box.paths.conf).replace('"EgressRegion": ""', '"EgressRegion": "DE"'));
        const conf = read(box.paths.conf);
        GLib.file_set_contents(box.paths.bin, '#!/bin/sh\n# my own build\n');
        GLib.chmod(box.paths.bin, 0o755);
        const again = await install(box, '--no-enable');
        equal(again.status, 0, again.err);
        assert(/keeping your Psiphon/.test(again.out) && /keeping your config/.test(again.out), again.out);
        equal(read(box.paths.bin), '#!/bin/sh\n# my own build\n');
        equal(read(box.paths.conf), conf);

        const update = await install(box, '--no-enable', '--update-psiphon');
        equal(update.status, 0, update.err);
        equal(sha256(box.paths.bin), box.env.PSIPHON_BIN_SHA256);
        equal(read(box.paths.conf), conf, 'the config stays');
    } finally {
        rmrf(box);
    }
});

test('--update-psiphon waits until Psiphon is stopped', async () => {
    const box = await sandbox();
    try {
        equal((await install(box, '--no-enable')).status, 0);
        equal((await run(box, [box.cmd('psi-on')])).status, 0);
        const r = await install(box, '--no-enable', '--update-psiphon');
        equal(r.status, 1);
        assert(/Stop it first: psi-off/.test(r.err), r.err);
        equal((await run(box, [box.cmd('psi-off')])).status, 0);
    } finally {
        rmrf(box);
    }
});

test('a download that does not match its checksum is refused and leaves nothing behind', async () => {
    const box = await sandbox();
    try {
        const r = await install(box, '--no-enable');
        equal(r.status, 0);
        GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(box.psidir)}`);
        const bad = await run(box, ['bash', script, '--no-enable'], {PSIPHON_BIN_SHA256: '0'.repeat(64)});
        equal(bad.status, 1);
        assert(/does not match its checksum/.test(bad.err), bad.err);
        equal(new TextDecoder().decode(GLib.spawn_command_line_sync(`ls -A ${GLib.shell_quote(box.psidir)}`)[1]), '', 'nothing left');
        const badConf = await run(box, ['bash', script, '--no-enable'], {PSIPHON_CONF_SHA256: '0'.repeat(64)});
        equal(badConf.status, 1);
        assert(!exists(box.paths.conf), 'no config');
    } finally {
        rmrf(box);
    }
});

test("someone else's psi-on and an alias that hides the command are left alone, with a word", async () => {
    const box = await sandbox();
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(box.cmd('psi-on')), 0o755);
        GLib.file_set_contents(box.cmd('psi-on'), '#!/bin/sh\necho mine\n');
        GLib.file_set_contents(GLib.build_filenamev([box.home, '.zshrc']), "export X=1\nalias psi-off='kill psiphon'\n");
        const r = await install(box, '--no-enable', '--no-psiphon');
        equal(r.status, 0, r.err);
        assert(/~\/\.local\/bin\/psi-on is someone else's, left alone/.test(r.out), r.out);
        assert(/~\/\.zshrc:2 has an alias/.test(r.out), r.out);
        equal(read(box.cmd('psi-on')), '#!/bin/sh\necho mine\n');
        equal(link(box.cmd('psi-off')), 'psi');
        assert(!exists(box.psidir), '--no-psiphon');
    } finally {
        rmrf(box);
    }
});

test('--dev links to the checkout; --uninstall takes away what it put and keeps ~/psiphon', async () => {
    const box = await sandbox();
    try {
        equal((await install(box, '--no-enable')).status, 0);
        const dev = await install(box, '--no-enable', '--dev');
        equal(dev.status, 0, dev.err);
        equal(link(box.ext), GLib.build_filenamev([repo, UUID]));
        equal(link(box.cmd('psi')), GLib.build_filenamev([repo, 'bin', 'psi']));
        equal((await install(box, '--no-enable')).status, 0);
        equal(link(box.ext), null, 'a copy again');

        GLib.mkdir_with_parents(box.at('state', 'psiphon-tunnel'), 0o755);
        GLib.file_set_contents(box.at('state', 'psiphon-tunnel', 'state.json'), '{"version":1,"proxy":null}');
        const r = await install(box, '--uninstall');
        equal(r.status, 0, r.err);
        for (const gone of [box.ext, box.cmd('psi'), box.cmd('psi-on'), box.cmd('psi-off'), box.at('state', 'psiphon-tunnel')])
            assert(!exists(gone), `${gone} is still there`);
        assert(exists(box.paths.bin) && exists(box.paths.conf), '~/psiphon stays');
    } finally {
        rmrf(box);
    }
});

// gsettings in a dbus-run-session, its dconf in the sandbox.
function haveSchemas(...ids) {
    const source = Gio.SettingsSchemaSource.get_default();
    return GLib.find_program_in_path('dbus-run-session') && ids.every(id => source?.lookup(id, true));
}

test('turns the extension on, sets the language, and puts the system proxy back on uninstall', async () => {
    if (!haveSchemas('org.gnome.shell', 'org.gnome.system.proxy')) {
        print('     (no GNOME schemas or dbus-run-session here: skipped)');
        return;
    }
    const box = await sandbox();
    try {
        const values = tunnelValues({http: 8081, socks: 1081});
        const previous = {'mode': 'none', 'http.host': '', 'http.port': 8080, 'https.host': '', 'https.port': 0,
            'socks.host': '', 'socks.port': 0};
        GLib.mkdir_with_parents(box.at('state', 'psiphon-tunnel'), 0o755);
        GLib.file_set_contents(box.at('state', 'psiphon-tunnel', 'state.json'),
            JSON.stringify({version: 1, proxy: {http: 8081, socks: 1081, values, previous}}));
        const set = Object.entries(values).map(([k, v]) => {
            const [child, name] = k.includes('.') ? k.split('.') : ['', k];
            return `gsettings set org.gnome.system.proxy${child ? `.${child}` : ''} ${name} ${typeof v === 'number' ? v : `'${v}'`}`;
        }).join('\n');
        const r = await run(box, ['dbus-run-session', '--', 'bash', '-c', `set -e
            bash "$0" --lang ru --no-psiphon
            echo "enabled: $(gsettings get org.gnome.shell enabled-extensions)"
            echo "language: $(gsettings --schemadir "$XDG_DATA_HOME/gnome-shell/extensions/${UUID}/schemas" get org.gnome.shell.extensions.psiphon-tunnel language)"
            ${set}
            bash "$0" --uninstall
            echo "after: $(gsettings get org.gnome.shell enabled-extensions)"
            echo "proxy: $(gsettings get org.gnome.system.proxy mode) $(gsettings get org.gnome.system.proxy.http port)"
            test -f "$XDG_CONFIG_HOME/dconf/user" && echo isolated`, script], {GSETTINGS_BACKEND: null});
        equal(r.status, 0, r.err + r.out);
        assert(/^isolated$/m.test(r.out), 'the dconf of the sandbox');
        assert(new RegExp(`^enabled: .*'${UUID}'`, 'm').test(r.out), r.out);
        assert(/^language: 'ru'$/m.test(r.out), r.out);
        assert(/^after: (@as \[\]|\[\])$/m.test(r.out), r.out);
        assert(/system proxy: put back/.test(r.out), r.out);
        assert(/^proxy: 'none' 8080$/m.test(r.out), r.out);
    } finally {
        rmrf(box);
    }
});
