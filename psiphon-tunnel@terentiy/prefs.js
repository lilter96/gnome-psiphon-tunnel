// The settings window: the language of the popup, the system proxy, and
// where Psiphon lives.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {LANGUAGES, setLanguage} from './lang.js';

const CODES = ['', ...Object.keys(LANGUAGES)];

export default class PsiphonTunnelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const T = setLanguage(settings.get_string('language'));
        const page = new Adw.PreferencesPage({title: T.prefs.general, icon_name: 'preferences-system-symbolic'});

        const general = new Adw.PreferencesGroup({title: T.prefs.general});
        const language = new Adw.ComboRow({
            title: T.prefs.language,
            subtitle: T.prefs.languageSub,
            model: Gtk.StringList.new([T.prefs.system, ...Object.values(LANGUAGES).map(l => l.name)]),
            selected: Math.max(0, CODES.indexOf(settings.get_string('language'))),
        });
        language.connect('notify::selected', () => settings.set_string('language', CODES[language.selected]));
        general.add(language);

        const proxy = new Adw.SwitchRow({title: T.settings.proxy, subtitle: T.prefs.proxySub});
        settings.bind('system-proxy', proxy, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(proxy);
        page.add(general);

        const psiphon = new Adw.PreferencesGroup({title: T.prefs.psiphon});
        const dir = GLib.build_filenamev([GLib.get_home_dir(), 'psiphon']);
        const folder = new Adw.ActionRow({title: T.prefs.folder, subtitle: '~/psiphon'});
        const open = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: T.prefs.openFolder,
            valign: Gtk.Align.CENTER,
            has_frame: false,
            sensitive: GLib.file_test(dir, GLib.FileTest.IS_DIR),
        });
        open.connect('clicked', () => Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(dir, null), null));
        folder.add_suffix(open);
        psiphon.add(folder);
        psiphon.add(new Adw.ActionRow({
            title: T.prefs.commands,
            subtitle: 'psi-on · psi-off · psi status · psi region DE',
            subtitle_selectable: true,
        }));
        page.add(psiphon);

        window.add(page);
    }
}
