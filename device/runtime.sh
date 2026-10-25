#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$base" in /mnt/onboard/.adds/kobold/releases/0.1.0|/tmp/kobold/release) ;; *) exit 1;; esac
[ "$(id -u)" = 0 ] || exit 1
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"
work=/tmp/kobold
socket=$work/tailscaled.sock
state=/usr/local/kobold-state/tailscale
pidfile=$work/supervisor.pid
[ ! -L "$state" ] && [ ! -L "$work" ] || exit 1
# Execute the daemon and firewall helpers from native RAM, with durable private
# state on root. They never keep the USB-exported FAT filesystem open or write
# client state there while the owner reconnects USB.
if [ "$base" = /mnt/onboard/.adds/kobold/releases/0.1.0 ]; then
    [ "$(id -u)" = 0 ] && [ ! -L "$work" ]
    mkdir -p "$work"; chmod 700 "$work"
    if [ ! -d "$work/release" ]; then
        required=$(du -sk "$base" | awk '{print $1}')
        available=$(df -Pk /tmp | awk 'END {print $4}')
        [ "$available" -ge "$((required+16384))" ] || { echo 'Insufficient RAM for the client' >&2; exit 1; }
        pending=$(mktemp -d "$work/release.XXXXXX")
        cp -R "$base/." "$pending/"
        (cd "$pending" && sha256sum -c SHA256SUMS >/dev/null)
        chmod 700 "$pending/"*.sh "$pending/bin/"* "$pending/libexec/"*
        mv "$pending" "$work/release"
    fi
    [ ! -L "$work/release" ]
    cmp "$base/SHA256SUMS" "$work/release/SHA256SUMS" >/dev/null || { echo 'Runtime changed; restart the Kobo before retrying' >&2; exit 1; }
    exec /bin/sh "$work/release/runtime.sh" "$@"
fi
export PATH="$base/bin:/usr/sbin:/usr/bin:/sbin:/bin"
is_owned_pid() {
    case "${1-}" in ''|*[!0-9]*) return 1;; esac
    [ -r "/proc/$1/cmdline" ] || return 1
    tr '\000' '\n' < "/proc/$1/cmdline" | grep -Fx "$base/runtime.sh" >/dev/null
}
stop_daemon() {
    if [ -f "$pidfile" ]; then
        pid=$(cat "$pidfile")
        is_owned_pid "$pid" || { echo 'Cannot establish process ownership; nothing killed' >&2; exit 1; }
        kill -TERM "$pid"
        i=0
        while is_owned_pid "$pid" && [ "$i" -lt 15 ]; do sleep 1; i=$((i+1)); done
        is_owned_pid "$pid" && { echo 'Process has not stopped; no files removed' >&2; exit 1; }
    fi
    return 0
}
case "${1-}" in
    start|trial)
        [ "$1" = trial ] || [ -f "$state/autostart" ] || exit 0
        /bin/sh "$base/probe.sh" preflight
        # /tmp is native Linux storage; never put locks or sockets on FAT.
        [ ! -L "$work" ] || exit 1
        mkdir -p "$work" "$state"
        chmod 700 "$work"
        mkdir "$work/start.lock" 2>/dev/null || exit 0
        trap 'rmdir "$work/start.lock" 2>/dev/null || :' EXIT
        if [ -f "$pidfile" ]; then
            pid=$(cat "$pidfile")
            if is_owned_pid "$pid"; then echo 'Already running'; exit 0; fi
            echo 'Stale supervisor record; reboot or inspect before restarting' >&2
            exit 1
        fi
        if pidof tailscaled >/dev/null 2>&1; then
            echo 'Another tailscaled process exists; inspect before starting' >&2
            exit 1
        fi
        # No persisted identity is created here unless tailscaled itself starts.
        setsid /bin/sh "$base/runtime.sh" supervise </dev/null >/dev/null 2>&1 &
        i=0
        while [ "$i" -lt 15 ]; do
            if timeout 2 "$base/bin/tailscale" --socket="$socket" status --json >/dev/null 2>&1; then
                echo 'Daemon answers; enrollment/connection still require inspection'; exit 0
            fi
            i=$((i+1)); sleep 1
        done
        echo 'Daemon did not become ready; use stop and inspect compatibility' >&2
        stop_daemon
        exit 1;;
    supervise)
        mkdir -p "$work" "$state"
        echo $$ > "$pidfile"
        child=''; made_tun=0
        cleanup() {
            trap '' HUP INT TERM
            if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || :; wait "$child" 2>/dev/null || :; fi
            # Never remove a pre-existing TUN device or its parent directory.
            if [ "$made_tun" = 1 ] && [ -c /dev/net/tun ]; then rm -f /dev/net/tun; fi
            rm -f "$pidfile"
        }
        trap cleanup EXIT
        trap 'exit 0' HUP INT TERM
        if [ ! -e /dev/net/tun ]; then
            [ -d /dev/net ] || { echo 'Missing /dev/net; inspect device first' > "$work/result"; exit 1; }
            mknod /dev/net/tun c 10 200
            chmod 600 /dev/net/tun
            made_tun=1
        fi
        [ -c /dev/net/tun ] || exit 1
        n=0
        while [ "$n" -lt 3 ]; do
            "$base/bin/tailscaled" --socket="$socket" --statedir="$state" \
                --state="$state/tailscaled.state" --tun=tailscale0 \
                --no-logs-no-support >/dev/null 2>&1 &
            child=$!
            if wait "$child"; then child=''; break; fi
            child=''; n=$((n+1)); sleep 2
        done
        echo 'Daemon exited; no unbounded log or restart loop' > "$work/result";;
    stop) stop_daemon;;
    cli) shift; exec "$base/bin/tailscale" --socket="$socket" "$@";;
    *) echo 'Usage: sh runtime.sh trial|start|stop|cli [tailscale arguments]' >&2; exit 1;;
esac
