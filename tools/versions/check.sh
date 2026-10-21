#!/bin/bash
# Runs the extension on other GNOME Shells, each in a container: the check
# mode of tools/media/capture.sh (the whole cycle against the fake Psiphon,
# no network) inside a headless Shell of that distribution. Nothing on the
# host is involved but docker.
#
#   tools/versions/check.sh fedora:42 ubuntu:26.04
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
uid=$(id -u)
failed=0
for image in "$@"; do
    name=${image//[:\/]/-}
    tag=pt-gnome:$name
    out=$here/out/$name
    rm -rf "$out"
    mkdir -p "$out"
    case $image in
    fedora:*)
        setup='dnf -y -q install gnome-shell mesa-dri-drivers dbus-daemon gcc iproute procps-ng dconf glib2
            util-linux curl tar google-noto-color-emoji-fonts && dnf clean all' ;;
    ubuntu:* | debian:*)
        setup='apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends
            gnome-shell libgl1-mesa-dri dbus-daemon dconf-service dconf-gsettings-backend libglib2.0-bin gcc
            libc6-dev iproute2 procps curl ca-certificates fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*' ;;
    *) echo "$image: only fedora, ubuntu and debian images" >&2; exit 2 ;;
    esac
    if ! docker image inspect "$tag" >/dev/null 2>&1; then
        echo "$image: building $tag"
        printf 'FROM %s\nRUN %s\n' "$image" "${setup//$'\n'/ }" | docker build -q -t "$tag" - >/dev/null
    fi
    # shellcheck disable=SC2016 # expanded inside the container
    docker run --rm -e "HOST_UID=$uid" -v "$repo:/src:ro" -v "$out:/out" "$tag" bash -c '
        user=$(getent passwd "$HOST_UID" | cut -d: -f1)
        [ -n "$user" ] || { useradd -m -u "$HOST_UID" tester && user=tester; }
        mkdir /work
        tar -C /src --exclude=./.git --exclude=./tools/media/out --exclude=./tools/versions/out -cf - . | tar -C /work -xf -
        chown -R "$user" /work
        runuser -u "$user" -- bash -c "cd /work && tools/media/capture.sh check"
        echo "capture exit $?"
        cp -r /work/tools/media/out/check/. /out/ 2>/dev/null
        chown -R "$HOST_UID" /out
    ' >"$out/run.log" 2>&1 || true
    version=$(sed -n 's/.*\[pt-media\] GNOME Shell \([^,]*\),.*/\1/p' "$out/shell.log" 2>/dev/null | head -n 1)
    pass=$(grep -c '\[pt-media\] PASS' "$out/shell.log" 2>/dev/null || true)
    fail=$(grep -c '\[pt-media\] FAIL' "$out/shell.log" 2>/dev/null || true)
    if [ -f "$out/meta.json" ] && [ "${fail:-0}" = 0 ]; then
        echo "$image: GNOME Shell $version, $pass checks passed"
    else
        failed=1
        echo "$image: GNOME Shell ${version:-?}, ${pass:-0} passed, ${fail:-0} failed (see $out)"
        grep -E '\[pt-media\] FAIL|JS ERROR|capture (exit|failed)' "$out/shell.log" "$out/run.log" 2>/dev/null | head -n 20
    fi
done
exit $failed
