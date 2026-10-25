#!/usr/bin/env python3
"""Fetch a pinned official Go SDK into ignored cache, without changing the host PATH."""

import argparse
import hashlib
import json
import platform
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PINS = {
    'Darwin-arm64': (
        'go1.27.3.darwin-arm64.tar.gz',
        'dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2',
    ),
    'Darwin-x86_64': (
        'go1.27.3.darwin-amd64.tar.gz',
        'b6f8e931e4ab497fcde6da8ae4499a58f9d258e55c8a80824a516eae5950a750',
    ),
    'Linux-x86_64': (
        'go1.27.3.linux-amd64.tar.gz',
        '65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40',
    ),
    'Linux-aarch64': (
        'go1.27.3.linux-arm64.tar.gz',
        'a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49',
    ),
}
# SHA256 values from https://go.dev/dl/?mode=json, reviewed 2026-10-25.
if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--download', action='store_true')
    a = p.parse_args()
    name, expected = PINS[platform.system() + '-' + platform.machine()]
    cache = ROOT / 'cache/toolchain'
    archive = cache / name
    cache.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        if not a.download:
            raise SystemExit('SDK missing; use --download explicitly')
        data = urllib.request.urlopen('https://go.dev/dl/' + name, timeout=60).read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise SystemExit('SDK checksum mismatch')
        archive.write_bytes(data)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise SystemExit('Cached SDK checksum mismatch')
    if not (cache / 'go/bin/go').exists():
        with tarfile.open(archive) as t:
            t.extractall(cache, filter='data')
    print(cache / 'go/bin/go')
