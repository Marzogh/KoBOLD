#!/usr/bin/env python3
"""Prepare attended packages and promote their unchanged archives after acceptance."""

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from build import build, signed
from build_collection import build_collection
from export_public import export, ROOT, POLICY
from prepare_sources import prepare

CHECKS = (
    'usbBackup',
    'systemBackup',
    'libraryExclusion',
    'installation',
    'enrolment',
    'sync',
    'automaticStartup',
    'rebootSync',
    'otherInternetSync',
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(site, production=False):
    subprocess.run(
        [
            'node',
            str(ROOT / 'tools/verify_site.mjs'),
            str(site),
            *(['--production'] if production else []),
        ],
        check=True,
    )


def seal(output):
    """Inventory the final static bytes before archiving the deployable directory."""
    site = output / 'site'
    files = {}
    for p in sorted(site.rglob('*')):
        if p.is_symlink():
            raise ValueError('Site contains a symlink')
        if p.is_file() and p.relative_to(site).as_posix() != 'PUBLICATION.json':
            files[p.relative_to(site).as_posix()] = {
                'sha256': digest(p),
                'bytes': p.stat().st_size,
            }
    (site / 'PUBLICATION.json').write_text(
        json.dumps(
            {
                'schema': 1,
                'kind': 'site',
                'files': files,
            },
            indent=2,
        )
        + '\n'
    )
    verify(site)
    archive = Path(shutil.make_archive(str(output / 'KoBOLD-0.1.0-site'), 'zip', site))
    (output / 'SHA256SUMS').write_text(digest(archive) + '  ' + archive.name + '\n')


def stage(output, cache, source_cache, key):
    """Create an explicitly attended install, without claiming hardware acceptance."""
    if output.exists() or key.resolve().is_relative_to(ROOT):
        raise ValueError('Use a new output and an external signing key')
    output.mkdir(parents=True)
    try:
        export(ROOT, output / 'site', 'site', json.loads(POLICY.read_text()))
        site = output / 'site'
        collector = build_collection(
            site / 'collection', key, ROOT / 'web/trust/collection-keys.json'
        )
        release = build(
            cache,
            site / 'releases/0.1.0',
            signing_key=key,
            trust=ROOT / 'web/trust/release-keys.json',
            collection=collector,
            connect_trial=True,
        )
        prepare(site / 'releases/0.1.0/sources', source_cache)
        (output / 'ACCEPTANCE-TEMPLATE.json').write_text(
            json.dumps(
                {
                    'schema': 1,
                    'profileId': release['profile']['id'],
                    'date': None,
                    'archiveSha256': release['updates']['bootstrap.tgz']['sha256'],
                    'collectionSha256': collector['archive']['sha256'],
                    'browser': None,
                    'hostOS': None,
                    'checks': {name: False for name in CHECKS},
                },
                indent=2,
            )
            + '\n'
        )
        seal(output)
    except BaseException:
        shutil.rmtree(output)
        raise


def acceptance(record, release, collector):
    """Require operator evidence bound to both immutable on-reader archives."""
    if (
        record.get('schema') != 1
        or record.get('profileId') != release['profile']['id']
        or record.get('archiveSha256') != release['updates']['bootstrap.tgz']['sha256']
        or record.get('collectionSha256') != collector['archive']['sha256']
        or any(
            not isinstance(record.get(k), str) or not record[k].strip()
            for k in ('date', 'browser', 'hostOS')
        )
        or any(record.get('checks', {}).get(k) is not True for k in CHECKS)
    ):
        raise ValueError('Complete matching hardware acceptance is required')


def promote(source, output, evidence, key):
    """Sign accepted metadata while preserving the archives actually tested."""
    if output.exists() or key.resolve().is_relative_to(ROOT):
        raise ValueError('Use a new output and an external signing key')
    verify(source / 'site')
    release = json.loads((source / 'site/releases/0.1.0/manifest.json').read_text())
    collector = json.loads((source / 'site/collection/manifest.json').read_text())
    record = json.loads(evidence.read_text())
    acceptance(record, release, collector)
    if (
        release['channel'] != 'attended-trial'
        or release['trial']['purpose'] != 'install-and-connect'
    ):
        raise ValueError('Expected the attended full installation package')
    output.mkdir(parents=True)
    try:
        shutil.copytree(source / 'site', output / 'site')
        record_bytes = (json.dumps(record, indent=2) + '\n').encode()
        release['channel'] = 'tested'
        release.pop('trial', None)
        release['profile']['bootstrapAccepted'] = True
        release['profile']['bootstrapEvidence'] = {
            'profileId': record['profileId'],
            'archiveSha256': record['archiveSha256'],
            'date': record['date'],
            'record': 'acceptance.json',
            'recordSha256': hashlib.sha256(record_bytes).hexdigest(),
        }
        collector['hardwareAccepted'] = True
        for folder, manifest, trust in (
            ('releases/0.1.0', release, 'release'),
            ('collection', collector, 'collection'),
        ):
            base = output / 'site' / folder
            data = (json.dumps(manifest, indent=2) + '\n').encode()
            (base / 'manifest.json').write_bytes(data)
            (base / 'manifest.signed.json').write_bytes(
                signed(data, key, ROOT / f'web/trust/{trust}-keys.json')
            )
        (output / 'site/releases/0.1.0/acceptance.json').write_bytes(record_bytes)
        seal(output)
        verify(output / 'site', production=True)
    except BaseException:
        shutil.rmtree(output)
        raise


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    for command in ('stage', 'promote'):
        c = sub.add_parser(command)
        c.add_argument('--output', type=Path, required=True)
        c.add_argument('--signing-key', type=Path, required=True)
        if command == 'stage':
            c.add_argument('--vendor-cache', type=Path, required=True)
            c.add_argument('--source-cache', type=Path, required=True)
        else:
            c.add_argument('--source', type=Path, required=True)
            c.add_argument('--acceptance', type=Path, required=True)
    a = p.parse_args()
    if a.command == 'stage':
        stage(a.output.resolve(), a.vendor_cache, a.source_cache, a.signing_key)
    else:
        promote(a.source.resolve(), a.output.resolve(), a.acceptance, a.signing_key)
