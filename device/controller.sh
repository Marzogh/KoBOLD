#!/bin/sh
# Fixed USB mailbox protocol. No eval, sourced requests, arbitrary command or server.
set -eu
umask 077
root=${KS_TEST_ROOT-}
trial_only=@TRIAL_ONLY@
if [ -n "$root" ]; then
    case "$root" in /*) ;; *) exit 1;; esac
    [ "$root" != / ] && [ -f "$root/.kobold-test-root" ] || exit 1
else
    [ "$(id -u)" = 0 ]
fi
kobold_home=$root/mnt/onboard/.adds/kobold
release=$kobold_home/releases/0.1.0
system=$root/usr/local/kobold-0.1.0
private_state=$root/usr/local/kobold-state/tailscale
rule=$root/etc/udev/rules.d/98-kobold-0.1.0.rules
work=$root/tmp/kobold-controller
# Neither request paths nor managed ancestors may be symlinks.
no_links() {
    check=$1
    while [ "$check" != / ] && [ "$check" != . ]; do
        [ ! -L "$check" ] || exit 1
        check=$(dirname "$check")
    done
}
no_links "$private_state"; no_links "$kobold_home"; no_links "$system"; no_links "$rule"; no_links "$work"
for path in state last-result.txt system-backup.tar.gz system-backup.tar.gz.pending backup-ack.txt health-ack.txt; do no_links "$kobold_home/$path"; done
[ -d "$kobold_home" ] || exit 0
mkdir -p "$work"
mkdir "$work/lock" 2>/dev/null || exit 0
trap 'rmdir "$work/lock" 2>/dev/null || :' EXIT
# Recover a consumed job or export its durable signed result before new work.
if [ -z "$root" ]; then "$system/provenance" job-recover 00000000000000000000000000000000; fi
# No request means only an already accepted autostart is permitted.
if [ ! -f "$kobold_home/request.txt" ]; then
    [ "$trial_only" != true ] || exit 0
    if [ -f "$private_state/autostart" ]; then
        [ -z "$root" ] || exit 0
        echo '@MANIFEST_SHA@  SHA256SUMS' | (cd "$release" && sha256sum -c - >/dev/null)
        "$system/provenance" startup "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
        /bin/sh "$release/runtime.sh" start
        exit 0
    fi
    exit 0
fi
no_links "$kobold_home/request.txt"
[ "$(wc -c < "$kobold_home/request.txt")" -le 1024 ]
id=''; action=''; profile=''; hostname=''; tag=''; seen=''
while IFS='=' read -r key value; do
    case "|$seen|" in *"|$key|"*) exit 1;; esac
    seen=$seen'|'$key
    case "$key" in
        id) id=$value;; action) action=$value;; profile) profile=$value;;
        hostname) hostname=$value;; tag) tag=$value;; *) exit 1;;
    esac
done < "$kobold_home/request.txt"
printf '%s' "$id" | grep -E '^[a-f0-9]{32}$' >/dev/null
case "$action" in inspect|enrol|status|enable|disable|uninstall) ;; *) exit 1;; esac
if [ "$trial_only" = true ]; then
    case "$action" in inspect|disable|uninstall) ;; *) echo 'Inspect-only trial: connection actions are disabled' >&2; exit 1;; esac
fi
[ "$profile" = libra-colour-390-4.46.23836 ]
printf '%s' "$hostname" | grep -E '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' >/dev/null
printf '%s' "$tag" | grep -E '^tag:[a-z][a-z0-9-]{0,62}$' >/dev/null
version=$(cat "$root/mnt/onboard/.kobo/version")
if [ "$action" != disable ] && [ "$action" != uninstall ]; then
    [ "$(printf '%s' "$version" | cut -d, -f3)" = 4.46.23836 ]
    printf '%s' "$version" | cut -d, -f1 | grep '^N428' >/dev/null
    printf '%s' "$version" | cut -d, -f6 | grep '390$' >/dev/null
fi
report=$kobold_home/reports/$id
no_links "$report"
if [ -z "$root" ]; then
    "$system/provenance" job-begin "$id"
else
    [ ! -e "$report" ]
fi
mkdir -p "$report"
for name in request.txt result.txt installation.json status-private.json sign-in.txt system-backup.sha256 probes-private.txt runtime-private.txt login-private.txt readiness.json recovery.txt provenance-error.txt; do no_links "$report/$name"; done
mv "$kobold_home/request.txt" "$report/request.txt"
failed() {
    if [ -z "$root" ]; then "$system/provenance" job-error "$id" || :; fi
    printf 'failed\n' > "$report/result.txt"; printf '%s\n' "$id" > "$kobold_home/last-result.txt"; }
trap 'failed; rmdir "$work/lock" 2>/dev/null || :' EXIT
case "$action" in
    inspect)
        # No daemon execution or networking changes before this archive is
        # copied to the owner's chosen backup folder and verified by the page.
        if [ ! -f "$kobold_home/system-backup.tar.gz" ]; then
            if [ -n "$root" ]; then
                tar -czf "$kobold_home/system-backup.tar.gz.pending" -C "$root" etc
            else
                tar -czf "$kobold_home/system-backup.tar.gz.pending" -C / etc
            fi
            mv "$kobold_home/system-backup.tar.gz.pending" "$kobold_home/system-backup.tar.gz"
        fi
        sha256sum "$kobold_home/system-backup.tar.gz" | cut -d' ' -f1 > "$report/system-backup.sha256"
        ;;
    disable|uninstall)
        no_links "$kobold_home/state"
        for marker in "$private_state/autostart" "$kobold_home/state/autostart"; do no_links "$marker"; if [ -f "$marker" ]; then rm "$marker"; fi; done
        # Recovery never executes a possibly corrupted onboard runtime. A normal
        # reboot terminates any active daemon after this action.
        if [ "$action" = uninstall ]; then
            if [ -e "$rule" ]; then
                echo '@RULE_SHA@  '"$rule" | sha256sum -c - >/dev/null
                rm "$rule"
            fi
            printf 'Startup disabled. Reboot to stop the current daemon. Payload, identity, books and configuration retained.\n' > "$report/recovery.txt"
        fi
        ;;
    enrol|status|enable)
        echo '@MANIFEST_SHA@  SHA256SUMS' | (cd "$release" && sha256sum -c - >/dev/null)
        (cd "$release" && sha256sum -c SHA256SUMS >/dev/null)
        no_links "$kobold_home/backup-ack.txt"
        [ -f "$kobold_home/system-backup.tar.gz" ] && [ -f "$kobold_home/backup-ack.txt" ]
        expected=$(cat "$kobold_home/backup-ack.txt")
        printf '%s' "$expected" | grep -E '^[a-f0-9]{64}$' >/dev/null
        [ "$(sha256sum "$kobold_home/system-backup.tar.gz" | cut -d' ' -f1)" = "$expected" ]
        [ -z "$root" ] || { echo 'Native execution forbidden in fake-root tests' >&2; exit 1; }
        "$system/provenance" verify "$id"
        /bin/sh "$release/probe.sh" > "$report/probes-private.txt" 2>&1
        /bin/sh "$release/runtime.sh" trial > "$report/runtime-private.txt" 2>&1
        if [ "$action" = enrol ]; then
            /bin/sh "$release/runtime.sh" cli up --hostname="$hostname" --advertise-tags="$tag" --accept-dns=false --accept-routes=false --ssh=false --shields-up=true --timeout=20s > "$report/login-private.txt" 2>&1 || :
            grep -Eo 'https://login\.tailscale\.com/a/[a-zA-Z0-9]+' "$report/login-private.txt" > "$report/sign-in.txt" || :
        fi
        "$system/provenance" "ready-$action" "$id"
        if [ "$action" = enable ]; then
            # Page must already have checked real sync; still verify Running and
            # empty Health from native status before allowing persistent startup.
            "$system/provenance" check-health "$id"
            # The browser separately parses JSON and checks the expected tag.
            no_links "$kobold_home/health-ack.txt"
            [ "$(cat "$kobold_home/health-ack.txt")" = "$expected" ]
            mkdir -p "$private_state"; chmod 700 "$private_state"; : > "$private_state/autostart"
        fi
        ;;
esac
# Recovery remains available if provenance is damaged, but cannot claim a
# managed healthy installation. Native receipts are required for normal jobs.
if [ -z "$root" ]; then
    case "$action" in
        disable|uninstall) "$system/provenance" "$action" "$id" || printf 'Provenance could not be verified; recovery only.\n' > "$report/provenance-error.txt";;
        *) "$system/provenance" "$action" "$id";;
    esac
fi
if [ -z "$root" ]; then
    "$system/provenance" job-finish "$id"
else
    printf 'complete\n' > "$report/result.txt"
    printf '%s\n' "$id" > "$kobold_home/last-result.txt"
fi
sync
trap 'rmdir "$work/lock" 2>/dev/null || :' EXIT
