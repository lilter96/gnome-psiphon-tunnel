#!/usr/bin/env bash
# Installs Psiphon Tunnel: Psiphon's console client in ~/psiphon, the psi,
# psi-on and psi-off commands in ~/.local/bin, and the GNOME Shell extension.
# Run it again to update: your Psiphon and your client.conf are kept.
#
#   ./install.sh                   all of it, and turn the extension on
#   ./install.sh --lang ru         the popup in Russian (en, ru; default: the system's)
#   ./install.sh --dev             link the extension to this folder instead of copying it
#   ./install.sh --update-psiphon  replace ~/psiphon/psiphon with the build pinned here
#   ./install.sh --no-psiphon      leave ~/psiphon alone: you bring your own
#   ./install.sh --no-enable       install, but leave the extension off
#   ./install.sh --uninstall       remove the extension and the commands; ~/psiphon stays
set -euo pipefail

UUID='psiphon-tunnel@terentiy'

# Psiphon's own build for Linux (GPL-3.0), pinned:
# https://github.com/Psiphon-Labs/psiphon-tunnel-core-binaries
PSIPHON_BIN_URL=${PSIPHON_BIN_URL:-https://raw.githubusercontent.com/Psiphon-Labs/psiphon-tunnel-core-binaries/33ff79e89260f3adf92e846b96b3369b86a819d8/linux/psiphon-tunnel-core-x86_64}
PSIPHON_BIN_SHA256=${PSIPHON_BIN_SHA256:-046ca168da25d2c0e61c1c15e2b73bfbb67f5208112a4c94fe58fc5aab784f19}
# The client config the PsiphonLinux project hands out, pinned. It is fetched
# here, not shipped: https://github.com/SpherionOS/PsiphonLinux
PSIPHON_CONF_URL=${PSIPHON_CONF_URL:-https://raw.githubusercontent.com/SpherionOS/PsiphonLinux/899eb8e3f3020473a184401ad67f80326fb999df/psiphon.config}
PSIPHON_CONF_SHA256=${PSIPHON_CONF_SHA256:-00c240e142484d252f07ad1f4d1f6ad56b2ac092e1344b51e0305f7517725c09}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
psidir=$HOME/psiphon
bindir=$HOME/.local/bin
extdir=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID
statedir=${XDG_STATE_HOME:-$HOME/.local/state}/psiphon-tunnel
marker="# psi-on and psi-off: Psiphon's console client"

if [ -t 1 ]; then
    B=$'\e[1m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' N=$'\e[0m'
else
    B='' G='' Y='' R='' N=''
fi
step() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
ok() { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die() {
    printf '%serror:%s %s\n' "$R" "$N" "$*" >&2
    exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }
tilde() { printf '%s' "${1/#$HOME/\~}"; }

dev=0 lang='' psiphon=1 update=0 enable=1 uninstall=0
while [ $# -gt 0 ]; do
    case $1 in
    --dev) dev=1 ;;
    --lang) lang=${2:-}; shift ;;
    --lang=*) lang=${1#--lang=} ;;
    --update-psiphon) update=1 ;;
    --no-psiphon) psiphon=0 ;;
    --no-enable) enable=0 ;;
    --uninstall) uninstall=1 ;;
    -h | --help)
        sed -n '2,/^set -e/{/^set -e/d;s/^# \{0,1\}//;p;}' "$0"
        exit 0
        ;;
    *) die "unknown option $1 (see ./install.sh --help)" ;;
    esac
    shift
done
case $lang in '' | en | ru) ;; *) die "--lang takes en or ru" ;; esac

# Leftovers of a download that did not finish.
scratch=()
trap 'rm -rf "${scratch[@]}"' EXIT

fetch() {
    case $1 in
    file://*) cp "${1#file://}" "$2" ;;
    *)
        if has curl; then
            curl -fsSL --retry 2 --connect-timeout 20 -o "$2" "$1"
        elif has wget; then
            wget -q -O "$2" "$1"
        else
            die "curl or wget is needed to download $1"
        fi
        ;;
    esac || die "could not download $1"
}

verify() {
    local got
    got=$(sha256sum "$1" | cut -d ' ' -f 1)
    [ "$got" = "$2" ] || die "$3 does not match its checksum (got $got, want $2). Nothing was installed from it."
}

# The Psiphons running from ~/psiphon/psiphon.
running_psiphon() {
    local want p
    want=$(readlink -f "$psidir/psiphon" 2>/dev/null) || return 0
    for p in /proc/[0-9]*; do
        [ "$(readlink -f "$p/exe" 2>/dev/null)" = "$want" ] && echo "${p#/proc/}"
    done
    return 0
}

# A command in ~/.local/bin we put there: psi itself, or a link to it.
ours() {
    if [ -L "$1" ]; then
        local target
        target=$(readlink "$1")
        [ "${target##*/}" = psi ] && return 0
        [ -e "$1" ] || return 1
    fi
    grep -qF "$marker" "$1" 2>/dev/null
}

# org.gnome.shell's list of enabled extensions, with ours added or taken out.
shell_list() {
    has gjs || return 1
    gjs -c "
        const {Gio} = imports.gi;
        const s = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const on = s.get_strv('enabled-extensions').filter(u => u !== '$UUID');
        s.set_strv('enabled-extensions', '$1' === 'add' ? [...on, '$UUID'] : on);
        s.set_strv('disabled-extensions', s.get_strv('disabled-extensions').filter(u => u !== '$UUID'));
        Gio.Settings.sync();
    " 2>/dev/null
}

check_system() {
    step "Checking the system"
    has gjs || die "gjs is missing: the extension needs GNOME Shell, which brings it"
    has glib-compile-schemas || die "glib-compile-schemas is missing (package libglib2.0-bin on Debian and Ubuntu)"
    local v supported
    v=$(gnome-shell --version 2>/dev/null | sed -n 's/^GNOME Shell \([0-9]*\).*/\1/p') || v=''
    supported=$(tr -d '\n ' <"$here/$UUID/metadata.json" | sed -n 's/.*"shell-version":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' ')
    if [ -z "$v" ]; then
        warn "GNOME Shell is not here: the commands work, the extension needs GNOME"
    elif [[ " $supported " == *" $v "* ]]; then
        ok "GNOME Shell $v"
    else
        warn "GNOME Shell $v: the extension is made for $supported and may not load here"
    fi
}

install_psiphon() {
    step "Psiphon in $(tilde "$psidir")"
    mkdir -p "$psidir"
    local bin=$psidir/psiphon conf=$psidir/client.conf tmp ports
    if [ -x "$bin" ] && [ $update = 0 ]; then
        ok "keeping your Psiphon: $(tilde "$bin")"
    else
        [ "$(uname -m)" = x86_64 ] || die "Psiphon builds its console client for x86_64 only, this is $(uname -m).
Build psiphon-tunnel-core yourself (it is Go), put it at $(tilde "$bin") and run ./install.sh again."
        [ -z "$(running_psiphon)" ] || die "Psiphon is running from $(tilde "$bin"). Stop it first: psi-off"
        tmp=$(mktemp "$psidir/.psiphon.XXXXXX")
        scratch+=("$tmp")
        note "downloading Psiphon's console client, about 10 MB…"
        fetch "$PSIPHON_BIN_URL" "$tmp"
        verify "$tmp" "$PSIPHON_BIN_SHA256" "The Psiphon download"
        chmod 755 "$tmp"
        mv -f "$tmp" "$bin"
        ok "Psiphon's console client, checksum verified: $(tilde "$bin")"
    fi

    if [ -f "$conf" ]; then
        ok "keeping your config: $(tilde "$conf")"
    else
        tmp=$(mktemp "$psidir/.client.XXXXXX")
        scratch+=("$tmp")
        fetch "$PSIPHON_CONF_URL" "$tmp"
        verify "$tmp" "$PSIPHON_CONF_SHA256" "The client config"
        mkdir -p "$psidir/data"
        chmod 700 "$psidir/data"
        ports=$(gjs -m "$here/tools/client-conf.js" "$tmp" "$psidir/data") || die "could not set up the client config"
        chmod 600 "$tmp"
        mv -f "$tmp" "$conf"
        ok "client config, checksum verified: $(tilde "$conf")"
        note "the fastest country; HTTP proxy 127.0.0.1:${ports% *}, SOCKS 127.0.0.1:${ports#* }"
    fi
}

install_commands() {
    step "psi, psi-on and psi-off in $(tilde "$bindir")"
    mkdir -p "$bindir"
    local name target rc
    for name in psi psi-on psi-off; do
        target=$bindir/$name
        if { [ -e "$target" ] || [ -L "$target" ]; } && ! ours "$target"; then
            warn "$(tilde "$target") is someone else's, left alone"
            continue
        fi
        rm -f "$target"
        if [ $name != psi ]; then
            ln -s psi "$target"
        elif [ $dev = 1 ]; then
            ln -s "$here/bin/psi" "$target"
        else
            install -m 755 "$here/bin/psi" "$target"
        fi
    done
    ok "psi-on, psi-off, psi status, psi region"
    case ":$PATH:" in
    *":$bindir:"*) ;;
    *) warn "$(tilde "$bindir") is not in your PATH yet: Ubuntu adds it at the next login, or add it to your shell's rc file" ;;
    esac
    for rc in "$HOME/.bashrc" "$HOME/.bash_aliases" "$HOME/.zshrc"; do
        [ -f "$rc" ] || continue
        # not grep | while: with pipefail, an rc with no such alias would end the install
        while IFS=: read -r line _; do
            warn "$(tilde "$rc"):$line has an alias that hides the command: remove it"
        done < <(grep -nE '^[[:space:]]*alias[[:space:]]+psi(-on|-off)?=' "$rc")
    done
}

install_extension() {
    step "The extension"
    mkdir -p "$(dirname "$extdir")"
    if [ -L "$extdir" ]; then
        rm "$extdir"
    elif [ -d "$extdir" ]; then
        grep -q "\"$UUID\"" "$extdir/metadata.json" 2>/dev/null || die "$extdir is there and is something else"
        rm -rf "$extdir"
    fi
    if [ $dev = 1 ]; then
        ln -s "$here/$UUID" "$extdir"
    else
        cp -r "$here/$UUID" "$extdir"
        rm -f "$extdir/schemas/gschemas.compiled"
    fi
    glib-compile-schemas --strict "$extdir/schemas"
    if [ $dev = 1 ]; then
        ok "$(tilde "$extdir") → $(tilde "$here/$UUID")"
    else
        ok "$(tilde "$extdir")"
    fi
    if [ -n "$lang" ]; then
        gsettings --schemadir "$extdir/schemas" set org.gnome.shell.extensions.psiphon-tunnel language "$lang"
        ok "popup language: $lang"
    fi
    if [ $enable = 0 ]; then
        return
    fi
    if gnome-extensions enable "$UUID" 2>/dev/null || shell_list add; then
        ok "turned on"
    else
        warn "could not turn it on: open Extensions and switch on Psiphon Tunnel"
    fi
    if gsettings get org.gnome.shell disable-user-extensions 2>/dev/null | grep -q true; then
        warn "extensions are switched off as a whole: turn them on at the top of the Extensions app"
    fi
}

uninstall() {
    step "Removing Psiphon Tunnel"
    # Turned off, the extension puts the system proxy back as it was.
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
    shell_list remove || true
    local state=$statedir/state.json i
    for i in 1 2 3 4 5 6 7 8 9 10; do
        grep -q '"proxy":{' "$state" 2>/dev/null || break
        [ "$i" = 10 ] && note "system proxy: $(gjs -m "$here/tools/restore-proxy.js" "$state")"
        sleep 0.3
    done
    if [ -L "$extdir" ] || grep -qs "\"$UUID\"" "$extdir/metadata.json"; then
        rm -rf "$extdir"
        ok "extension removed"
    fi
    local name
    for name in psi psi-on psi-off; do
        if ours "$bindir/$name"; then
            rm -f "$bindir/$name"
        fi
    done
    ok "psi, psi-on and psi-off removed"
    rm -rf "$statedir"
    if has dconf; then
        dconf reset -f /org/gnome/shell/extensions/psiphon-tunnel/ 2>/dev/null || true
    fi
    ok "settings removed"
    note "$(tilde "$psidir") stays: Psiphon, its config and its data. Delete it yourself if you want it gone."
    local pids
    pids=$(running_psiphon | tr '\n' ' ')
    pids=${pids% }
    [ -z "$pids" ] || note "Psiphon is still running (pid $pids). To stop it: kill $pids"
}

next_steps() {
    step "Done"
    if [ $enable = 1 ]; then
        if [ "${XDG_SESSION_TYPE:-}" = x11 ]; then
            note "GNOME loads the extension after a Shell restart: Alt+F2, type r, Enter."
        else
            note "GNOME loads the extension at the next login: log out and back in."
        fi
        note "Then click the mole in the top bar and turn the tunnel on."
    fi
    note "In a terminal: psi-on, psi-off, psi status, psi region DE, psi region auto"
    note "Settings: gnome-extensions prefs $UUID"
}

if [ $uninstall = 1 ]; then
    uninstall
    exit 0
fi
check_system
[ $psiphon = 0 ] || install_psiphon
install_commands
install_extension
next_steps
