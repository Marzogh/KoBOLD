#!/usr/bin/env python3
"""Package a signed, non-installable review bundle without publishing or key activation."""

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from build import build
from build_collection import build_collection
from export_public import export, ROOT, POLICY
from prepare_sources import prepare


def package(output, vendor_cache, source_cache, key, trust):
    """Build from explicit inventories, retaining closed production acceptance gates."""
    if output.exists():
        raise ValueError('Review output already exists')
    if key.resolve().is_relative_to(ROOT):
        raise ValueError('Keep the review private key outside the repository')
    profile = json.loads((ROOT / 'device/profile.json').read_text())
    if profile['bootstrapAccepted'] or profile.get('bootstrapEvidence'):
        raise ValueError('Review packaging requires unpromoted profile metadata')
    for name in ('release', 'collection'):
        if json.loads((ROOT / f'web/trust/{name}-keys.json').read_text()):
            raise ValueError('Review packaging requires empty production trust')
    output.mkdir(parents=True)
    try:
        policy = json.loads(POLICY.read_text())
        export(ROOT, output / 'source', 'source', policy)
        export(ROOT, output / 'site', 'site', policy)
        site = output / 'site'
        for name in ('release', 'collection'):
            shutil.copyfile(trust, site / f'trust/{name}-keys.json')
        collector = build_collection(site / 'collection', key, trust)
        manifest = build(
            vendor_cache,
            site / 'releases/0.1.0',
            signing_key=key,
            trust=trust,
            collection=collector,
        )
        if manifest['channel'] != 'candidate':
            raise ValueError('Review package must remain a candidate')
        prepare(site / 'releases/0.1.0/sources', source_cache)
        # Record final bytes after trust injection and generated assets are added.
        records = {}
        for path in sorted(site.rglob('*')):
            if path.is_symlink():
                raise ValueError('Symlink in review output')
            if path.is_file() and path.name != 'PUBLICATION.json':
                data = path.read_bytes()
                records[path.relative_to(site).as_posix()] = {
                    'sha256': hashlib.sha256(data).hexdigest(),
                    'bytes': len(data),
                }
        (site / 'PUBLICATION.json').write_text(
            json.dumps(
                {
                    'schema': 1,
                    'kind': 'site',
                    'preview': False,
                    'reviewOnly': True,
                    'files': records,
                },
                indent=2,
            )
            + '\n'
        )
        for kind in ('source', 'site'):
            shutil.make_archive(
                str(output / ('KoBOLD-0.1.0-review-' + kind)), 'zip', output / kind
            )
        checksums = {}
        for archive in sorted(output.glob('*.zip')):
            checksums[archive.name] = hashlib.sha256(archive.read_bytes()).hexdigest()
        (output / 'SHA256SUMS').write_text(
            ''.join(digest + '  ' + name + '\n' for name, digest in checksums.items())
        )
        (output / 'REVIEW.json').write_text(
            json.dumps(
                {
                    'schema': 1,
                    'version': '0.1.0',
                    'channel': 'candidate',
                    'deploymentApproved': False,
                    'productionSignerActivated': False,
                    'bootstrapAccepted': False,
                    'checksums': checksums,
                    'bootstrapSha256': manifest['updates']['bootstrap.tgz']['sha256'],
                    'collectionSha256': collector['archive']['sha256'],
                    'note': 'Separate review key. Not an installable or approved production release.',
                },
                indent=2,
            )
            + '\n'
        )
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--vendor-cache', type=Path, required=True)
    parser.add_argument('--source-cache', type=Path, required=True)
    parser.add_argument('--review-key', type=Path, required=True)
    parser.add_argument('--review-trust', type=Path, required=True)
    args = parser.parse_args()
    package(
        args.output.resolve(),
        args.vendor_cache,
        args.source_cache,
        args.review_key,
        args.review_trust,
    )
    print(
        'Signed review bundle prepared. No publishing or production activation performed.'
    )
