#!/usr/bin/env python3
"""Collect pinned corresponding Debian source beside the candidate binaries."""

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def prepare(output, cache, download=False):
    lock = json.loads((ROOT / 'device/sources.lock.json').read_text())
    cache.mkdir(parents=True, exist_ok=True)
    verified = []
    for entry in lock['files']:
        name = entry['filename']
        if Path(name).name != name:
            raise ValueError('Unsafe source filename')
        p = cache / name
        if not p.exists():
            if not download:
                raise ValueError('Missing cached source ' + name)
            data = urllib.request.urlopen(entry['url'], timeout=60).read()
            if hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValueError('Source download checksum mismatch')
            p.write_bytes(data)
        data = p.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('Cached source checksum mismatch')
        verified.append((name, data))
    if output.exists():
        raise ValueError('Source output already exists')
    output.mkdir(parents=True)
    for name, data in verified:
        (output / name).write_bytes(data)
    (output / 'sources.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
    (output / 'README.txt').write_text(
        'Matching Debian source: iptables 1.4.21-2, binary rebuild +b1.\nKeep the .dsc, orig tarball and Debian patch tarball together.\nUse dpkg-source -x iptables_1.4.21-2.dsc on a compatible Debian build host.\nThe unpacked debian/rules and debian/control document build instructions/dependencies.\nNo vendor sources were modified or rebuilt for this candidate.\nTailscale upstream: https://github.com/tailscale/tailscale/tree/v1.104.2\nTailscale BSD notice is included. Review transitive notices before publication.\n'
    )


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, default=ROOT / 'web/releases/0.1.0/sources')
    p.add_argument('--cache', type=Path, default=ROOT / 'cache/sources')
    p.add_argument('--download', action='store_true')
    a = p.parse_args()
    prepare(a.output, a.cache, a.download)
    print('Verified sources and notices prepared')
