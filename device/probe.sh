#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ "$(id -u)" = 0 ]
case "$base" in /mnt/onboard/.adds/kobold/releases/0.1.0|/tmp/kobold/release) ;; *) exit 1;; esac
[ "$(uname -m)" = armv7l ]
case "$(uname -r)" in 4.9.77*) ;; *) echo 'Unsupported kernel' >&2; exit 1;; esac
version=$(cat /mnt/onboard/.kobo/version)
[ "$(printf '%s' "$version" | cut -d, -f3)" = 4.46.23836 ]
printf '%s' "$version" | cut -d, -f1 | grep '^N428' >/dev/null
printf '%s' "$version" | cut -d, -f6 | grep '390$' >/dev/null
(cd "$base" && sha256sum -c SHA256SUMS >/dev/null)
for cmd in setsid timeout pidof sha256sum cmp mknod mktemp tar awk base64; do command -v "$cmd" >/dev/null; done
[ -e /lib/ld-linux-armhf.so.3 ]
[ "$(df -Pk /tmp | awk 'END {print $4}')" -ge 8192 ]
[ "$(df -Pk /mnt/onboard | awk 'END {print $4}')" -ge 65536 ]
[ "${1-}" != preflight ] || exit 0
for tool in iptables ip6tables; do
    timeout 10 "$base/bin/$tool" --version
    for match in mark connmark conntrack tcp udp statistic; do
        timeout 10 "$base/bin/$tool" -m "$match" --help >/dev/null
    done
    for target in ACCEPT MARK CONNMARK TCPMSS; do
        timeout 10 "$base/bin/$tool" -j "$target" --help >/dev/null
    done
    for target in MASQUERADE DNAT SNAT; do
        timeout 10 "$base/bin/$tool" -t nat -j "$target" --help >/dev/null
    done
done
