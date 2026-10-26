import hashlib
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from package_release import acceptance, CHECKS
from unpack_site import unpack


class ReleaseTests(unittest.TestCase):
    def test_acceptance_requires_all_checks_and_both_exact_archives(self):
        release = {
            'profile': {'id': 'profile'},
            'updates': {'bootstrap.tgz': {'sha256': 'a' * 64}},
        }
        collector = {'archive': {'sha256': 'b' * 64}}
        record = {
            'schema': 1,
            'profileId': 'profile',
            'archiveSha256': 'a' * 64,
            'collectionSha256': 'b' * 64,
            'date': '2026-10-26',
            'browser': 'Chromium',
            'hostOS': 'test host',
            'checks': {k: True for k in CHECKS},
        }
        acceptance(record, release, collector)
        for key in (
            'archiveSha256',
            'collectionSha256',
            'profileId',
            'date',
            'browser',
            'hostOS',
        ):
            with self.subTest(key=key), self.assertRaises(ValueError):
                acceptance({**record, key: ''}, release, collector)
        for key in CHECKS:
            with self.subTest(key=key), self.assertRaises(ValueError):
                acceptance(
                    {**record, 'checks': {**record['checks'], key: False}},
                    release,
                    collector,
                )

    def test_deployment_zip_rejects_wrong_hash_traversal_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, symlink in [
                ('index.html', False),
                ('../outside', False),
                ('link', True),
            ]:
                archive = root / 'site.zip'
                with zipfile.ZipFile(archive, 'w') as z:
                    info = zipfile.ZipInfo(name)
                    if symlink:
                        info.create_system = 3
                        info.external_attr = 0o120777 << 16
                    z.writestr(info, 'content')
                digest = hashlib.sha256(archive.read_bytes()).hexdigest()
                out = root / 'out'
                with self.assertRaises(ValueError):
                    unpack(archive, out, '0' * 64)
                if name == 'index.html':
                    unpack(archive, out, digest)
                    self.assertEqual((out / name).read_text(), 'content')
                    (out / name).unlink()
                    out.rmdir()
                else:
                    with self.assertRaises(ValueError):
                        unpack(archive, out, digest)
                    self.assertFalse(out.exists())
            self.assertFalse((root / 'outside').exists())

    def test_promotion_preserves_archives_and_requires_signed_fixture_evidence(self):
        import os
        import subprocess
        from unittest.mock import patch
        import package_release as packaging
        from build import signed

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve() / 'repo'
            trust = root / 'web/trust'
            trust.mkdir(parents=True)
            key = Path(tmp).resolve() / 'fixture.pem'
            subprocess.run(
                [
                    'node',
                    '--input-type=module',
                    '-e',
                    "import{generateKeyPairSync}from'node:crypto';import{writeFileSync as w}from'node:fs';const k=generateKeyPairSync('ed25519');w(process.argv[1],k.privateKey.export({type:'pkcs8',format:'pem'}));w(process.argv[2],JSON.stringify({fixture:k.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64')}));",
                    str(key),
                    str(trust / 'release-keys.json'),
                ],
                check=True,
                capture_output=True,
            )
            (trust / 'collection-keys.json').write_bytes(
                (trust / 'release-keys.json').read_bytes()
            )
            (root / 'tools').mkdir()
            (root / 'tools/verify_site.mjs').write_bytes(
                (ROOT / 'tools/verify_site.mjs').read_bytes()
            )
            source = root / 'attended'
            site = source / 'site'
            (site / 'releases/0.1.0/sources').mkdir(parents=True)
            (site / 'collection').mkdir()
            (site / 'trust').mkdir()
            for role in ('release', 'collection'):
                (site / f'trust/{role}-keys.json').write_bytes(
                    (trust / f'{role}-keys.json').read_bytes()
                )
            (site / 'index.html').write_text('<html>Fixture</html>')
            (site / 'releases/0.1.0/sources/sources.lock.json').write_text(
                '{"files":[]}'
            )
            data = b'NONEXECUTABLE TEST ARCHIVE'
            digest = hashlib.sha256(data).hexdigest()
            asset = {'url': 'bootstrap.tgz', 'size': len(data), 'sha256': digest}
            (site / 'releases/0.1.0/bootstrap.tgz').write_bytes(data)
            (site / 'collection/collection.tgz').write_bytes(data)
            release = {
                'namespace': 'kobold',
                'channel': 'attended-trial',
                'trial': {'purpose': 'install-and-connect'},
                'profile': {'id': 'fixture', 'bootstrapAccepted': False},
                'files': [],
                'updates': {'bootstrap.tgz': asset},
                'preflight': {
                    'collection': {'id': 'fixture', 'descriptorSha256': 'f' * 64}
                },
            }
            collector = {
                'id': 'fixture',
                'descriptorSha256': 'f' * 64,
                'hardwareAccepted': False,
                'archive': {**asset, 'url': 'collection.tgz'},
            }
            for folder, value, role in [
                ('releases/0.1.0', release, 'release'),
                ('collection', collector, 'collection'),
            ]:
                raw = (json.dumps(value, indent=2) + '\n').encode()
                (site / folder / 'manifest.json').write_bytes(raw)
                (site / folder / 'manifest.signed.json').write_bytes(
                    signed(raw, key, trust / f'{role}-keys.json')
                )
            record = {
                'schema': 1,
                'profileId': 'fixture',
                'archiveSha256': digest,
                'collectionSha256': digest,
                'date': '2026-10-26',
                'browser': 'fixture',
                'hostOS': 'fixture',
                'checks': {k: True for k in CHECKS},
            }
            evidence = root / 'acceptance.json'
            evidence.write_text(json.dumps(record))
            with (
                patch.object(packaging, 'ROOT', root),
                patch.dict(os.environ, {'KOBOLD_SIGNING_PASSPHRASE': ''}),
            ):
                packaging.seal(source)
                output = root / 'accepted'
                packaging.promote(source, output, evidence, key)
                self.assertEqual(
                    (output / 'site/releases/0.1.0/bootstrap.tgz').read_bytes(), data
                )
                (output / 'site/releases/0.1.0/acceptance.json').write_text('{}')
                with self.assertRaises(subprocess.CalledProcessError):
                    packaging.verify(output / 'site', production=True)
