#!/bin/sh
# Installed at a new versioned namespace. Never edits the OS boot script.
if [ "${1-}" != detached ]; then
    setsid /bin/sh "$0" detached </dev/null >/dev/null 2>&1 &
    exit 0
fi
n=0
while [ "$n" -lt 45 ]; do
    # Kobo must have remounted onboard storage after USB export.
    if awk '$2 == "/mnt/onboard" {found=1} END {exit !found}' /proc/mounts; then
        sleep 2
        if awk '$2 == "/mnt/onboard" {found=1} END {exit !found}' /proc/mounts; then
            exec /bin/sh /usr/local/kobold-0.1.0/controller.sh
        fi
    fi
    n=$((n+1)); sleep 1
 done
exit 0
