#!/usr/bin/env python3
"""Build a distinct collection package. No reader access, server or key activation."""

import argparse
import json
import secrets
from pathlib import Path
from build import ROOT, archive, sha, helper, signed


def build_collection(output, key, trust):
    if output.exists():
        raise ValueError('Collection output already exists')
    if key is None:
        raise ValueError('A separately supplied signing key is required')
    identifier = secrets.token_hex(16)
    base = 'usr/local/kobold-preflight-' + identifier
    rule = 'etc/udev/rules.d/98-kobold-preflight-' + identifier + '.rules'
    home = '/mnt/onboard/.adds/kobold-preflight/' + identifier
    bootstrap = (
        (ROOT / 'device/bootstrap.sh')
        .read_text()
        .replace(
            'exec /bin/sh /usr/local/kobold-0.1.0/controller.sh',
            'exec /' + base + '/provenance collect ' + identifier + '',
        )
    )
    files = {
        base + '/bootstrap.sh': bootstrap.encode(),
        base + '/provenance': helper(ROOT),
        base + '/GO-LICENSE.txt': (
            ROOT / 'device/provenance/GO-LICENSE.txt'
        ).read_bytes(),
        base + '/release-keys.json': trust.read_bytes(),
        rule: (
            'KERNEL=="loop0", ACTION=="add", RUN+="/bin/sh /'
            + base
            + '/bootstrap.sh"\nKERNEL=="wlan*", ACTION=="add", RUN+="/bin/sh /'
            + base
            + '/bootstrap.sh"\n'
        ).encode(),
    }
    descriptor = {
        'purpose': 'collect-preflight',
        'id': identifier,
        'files': {'/' + name: sha(data) for name, data in files.items()},
    }
    payload = json.dumps(descriptor, sort_keys=True, separators=(',', ':')).encode()
    files[base + '/release.json'] = signed(payload, key, trust)
    data = archive(files)
    manifest = {
        'schema': 1,
        'purpose': 'collect-preflight',
        'profileId': 'libra-colour-390-4.46.23836',
        'id': identifier,
        'descriptorSha256': sha(payload),
        'archive': {'url': 'collection.tgz', 'size': len(data), 'sha256': sha(data)},
        'rootFiles': sorted('/' + name for name in files),
        'rootWritesBeforeBackup': True,
        'hardwareAccepted': False,
    }
    output.mkdir(parents=True)
    (output / 'collection.tgz').write_bytes(data)
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (output / 'manifest.signed.json').write_bytes(
        signed((output / 'manifest.json').read_bytes(), key, trust)
    )
    return manifest


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--signing-key', type=Path, required=True)
    p.add_argument('--trust', type=Path, required=True)
    a = p.parse_args()
    m = build_collection(a.output, a.signing_key, a.trust)
    print(
        json.dumps(
            {'id': m['id'], 'archive': m['archive'], 'rootFiles': m['rootFiles']}
        )
    )
