#!/bin/bash
# Runs the extension on other GNOME Shells, each in a container: the check
# mode of tools/media/capture.sh (the whole cycle against the fake Psiphon,
# no network) inside a headless Shell of that distribution. Nothing on the
# host is involved but docker.
#
#   tools/versions/check.sh fedora:42 ubuntu:26.04
#
# Each container installs the Shell (about 2 GB in docker's root dir) and is
# removed with it: only the distribution's base image stays.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
uid=$(id -u)
root=$(docker info -f '{{.DockerRootDir}}')
failed=0
for image in "$@"; do
    name=${image//[:\/]/-}
    out=$here/out/$name
    rm -rf "$out"
    mkdir -p "$out"
    case $image in
    fedora:*)
        # Cisco's openh264 mirror refuses some countries; nothing here needs it
        setup='dnf -y -q --disablerepo=fedora-cisco-openh264 install gnome-shell mesa-dri-drivers dbus-daemon gcc
            iproute procps-ng dconf glib2 util-linux curl tar google-noto-color-emoji-fonts' ;;
    almalinux:* | rockylinux:*)
        setup='dnf -y -q install gnome-shell mesa-dri-drivers dbus-daemon gcc iproute procps-ng dconf glib2
            util-linux tar' ;;
    ubuntu:* | debian:*)
        # Ubuntu 24.04 keeps the settings window's program in a package of its own
        # shellcheck disable=SC2016 # expanded inside the container
        setup='apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends
            gnome-shell libgl1-mesa-dri dbus-daemon dconf-service dconf-gsettings-backend libglib2.0-bin gcc
            libc6-dev iproute2 procps curl ca-certificates fonts-noto-color-emoji
            $(apt-cache show gnome-shell-extension-prefs >/dev/null 2>&1 && echo gnome-shell-extension-prefs)' ;;
    *) echo "$image: only fedora, almalinux, rockylinux, ubuntu and debian images" >&2; exit 2 ;;
    esac
    free=$(df -Pk "$root" | awk 'NR == 2 {print int($4 / 1048576)}')
    if [ "$free" -lt 4 ]; then
        echo "$image: ${free} GB free in $root, the Shell needs about 2; stopping" >&2
        exit 2
    fi
    echo "$image: installing GNOME Shell and running the check"
    # shellcheck disable=SC2016 # expanded inside the container
    docker run --rm -e "HOST_UID=$uid" -e "SETUP=${setup//$'\n'/ }" -v "$repo:/src:ro" -v "$out:/out" "$image" bash -c '
        eval "$SETUP" >/out/setup.log 2>&1 || { echo "the packages did not install, see setup.log"; exit 1; }
        mkdir -p /run/dbus && dbus-daemon --config-file=/src/tools/versions/system-bus.conf --fork
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
        grep -E '\[pt-media\] FAIL|JS ERROR|capture (exit|failed)|did not install' "$out/shell.log" "$out/run.log" 2>/dev/null | head -n 20
    fi
done
exit $failed
