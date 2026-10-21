#!/bin/bash
# Runs psiphon-tunnel in a throwaway headless GNOME Shell 46 and takes screenshots.
#
# Your session is not touched: the shell gets its own session bus, dconf, XDG
# dirs, runtime dir and $HOME, with its own ~/psiphon in it. The Psiphon there
# is a copy on test ports 18081/11081 with its own data, so the extension never
# sees, starts or stops yours. It runs in the plain "user" mode: Ubuntu's mode
# loads Desktop Icons NG, whose init() kills every desktop-icons process of the
# user, including your session's.
#
#   tools/media/capture.sh smoke      # a real Psiphon copy, real network
#   tools/media/capture.sh media      # the fake Psiphon from tests/ → docs/media
#   PT_MEDIA_LANG=ru tools/media/capture.sh smoke     # the popup in Russian
set -euo pipefail
mode=${1:-smoke}
lang=${PT_MEDIA_LANG:-en}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out=$here/out/$mode
rm -rf "$out"
mkdir -p "$out"
tmp=$(mktemp -d)

# Kills whatever runs from the throwaway home: a Psiphon copy outlives the shell.
reap() {
    local p exe
    for p in /proc/[0-9]*; do
        exe=$(readlink "$p/exe" 2>/dev/null) || continue
        case $exe in "$tmp"/*) kill -KILL "${p#/proc/}" 2>/dev/null || true ;; esac
    done
}
trap 'reap; rm -rf "$tmp"' EXIT

for port in 18081 11081; do
    if ss -Hltn "sport = :$port" | grep -q .; then echo "port $port is busy, stopping"; exit 2; fi
done
mkdir -p "$tmp"/{config,state,cache} "$tmp/data/gnome-shell/extensions" "$tmp/home/psiphon"
mkdir -m 700 "$tmp/runtime"
ln -s "$repo/psiphon-tunnel@terentiy" "$here/pt-media@local" "$tmp/data/gnome-shell/extensions/"
schemas=$repo/psiphon-tunnel@terentiy/schemas
glib-compile-schemas --strict "$schemas"

psi=$tmp/home/psiphon
if [ "$mode" = smoke ]; then
    cp "$HOME/psiphon/psiphon" "$psi/psiphon"
    # your config with the test ports; it stays in the throwaway home
    python3 - "$HOME/psiphon/client.conf" "$psi/client.conf" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
c.update(LocalHttpProxyPort=18081, LocalSocksProxyPort=11081)
open(sys.argv[2], 'w').write(json.dumps(c, indent=2))
PY
    chmod 600 "$psi/client.conf"
else
    cc -O1 -o "$psi/psiphon" "$repo/tests/fake-psiphon.c"
    echo '{"LocalHttpProxyPort": 18081, "LocalSocksProxyPort": 11081, "EgressRegion": ""}' > "$psi/client.conf"
fi

real_psiphon=$(pgrep -x psiphon || true)
real_dconf=$HOME/.config/dconf/user
dconf_before=$(stat -c %Y "$real_dconf" 2>/dev/null || echo none)
desktop_icons() { pgrep -f 'ding@rastersoft.com/app/[d]ing.js' || true; }
icons_before=$(desktop_icons)

export HOME=$tmp/home XDG_CONFIG_HOME=$tmp/config XDG_DATA_HOME=$tmp/data XDG_STATE_HOME=$tmp/state \
    XDG_CACHE_HOME=$tmp/cache XDG_RUNTIME_DIR=$tmp/runtime PT_MEDIA_OUT=$out PT_MEDIA_MODE=$mode \
    PT_MEDIA_LANG=$lang PT_SCHEMAS=$schemas
unset DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_SESSION_ID GNOME_SHELL_SESSION_MODE
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
# shellcheck disable=SC2016 # expanded by the inner shell
timeout 600 dbus-run-session -- bash -c '
    gsettings set org.gnome.shell enabled-extensions "[\"psiphon-tunnel@terentiy\", \"pt-media@local\"]"
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    gsettings set org.gnome.desktop.interface scaling-factor 2
    gsettings --schemadir "$PT_SCHEMAS" set org.gnome.shell.extensions.psiphon-tunnel language "$PT_MEDIA_LANG"
    [ -f "$XDG_CONFIG_HOME/dconf/user" ] || { echo "dconf is not isolated, stopping"; exit 3; }
    exec nice -n 10 gnome-shell --mode=user --headless --no-x11 --virtual-monitor 2560x2200
' >"$out/shell.log" 2>&1 || true
reap
grep -E '\[pt-media\]|psiphon-tunnel|JS ERROR|JS WARNING|stopping' "$out/shell.log" || true

for pid in $real_psiphon; do
    [ -d "/proc/$pid" ] || echo "warning: your Psiphon $pid is gone" >&2
done
[ "$(stat -c %Y "$real_dconf" 2>/dev/null || echo none)" = "$dconf_before" ] ||
    echo "warning: your dconf changed during the capture" >&2
[ "$(desktop_icons)" = "$icons_before" ] ||
    echo "warning: the desktop icons of your session were restarted during the capture" >&2
[ -f "$out/meta.json" ] || { echo "capture failed"; exit 1; }
if grep -q '": false' "$out/meta.json"; then echo "some checks failed"; exit 1; fi
[ "$mode" = media ] || exit 0

gjs -m "$here/compose.js" "$out" "$repo/docs/media"
ffmpeg -loglevel error -y -framerate 30 -i "$out/frames/seq_%04d.png" \
    -c:v libwebp_anim -lossless 0 -q:v 80 -compression_level 6 -loop 0 \
    "$repo/docs/media/demo.webp"
ls -l "$repo/docs/media"
