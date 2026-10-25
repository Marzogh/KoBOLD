#!/bin/sh
# Scope legacy ABI libraries to this one helper, never the whole daemon/system.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
case "$(basename -- "$0")" in
    iptables) tool=iptables;;
    ip6tables) tool=ip6tables;;
    *) exit 1;;
esac
# /mnt/onboard is FAT: MARK and mark cannot coexist there. Each invocation
# uses a private native /tmp directory, with no shared cache or lock race.
extensions=$(mktemp -d /tmp/kobold-xtables.XXXXXX) || exit 1
cleanup() { rm -f "$extensions/"*.so; rmdir "$extensions"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
tar -xf "$base/lib/xtables.tar" -C "$extensions"
XTABLES_LIBDIR="$extensions" LD_LIBRARY_PATH="$base/lib" "$base/libexec/$tool" "$@"
