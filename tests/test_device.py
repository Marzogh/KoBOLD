import io
import json
import hashlib
import importlib.util
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build', ROOT / 'tools/build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / 'source'
        shutil.copytree(ROOT / 'device', self.source / 'device')
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.output = self.root / 'release'
        lock = json.loads((self.source / 'device/vendor.lock.json').read_text())
        for name, item in lock.items():
            if name == 'tailscale':
                names = [
                    'tailscale_1.104.2_arm/tailscale',
                    'tailscale_1.104.2_arm/tailscaled',
                ]
            elif name == 'firewall':
                names = [
                    './sbin/xtables-multi',
                    './lib/libip4tc.so.0.1.0',
                    './lib/libip6tc.so.0.1.0',
                    './usr/share/doc/iptables/copyright',
                ] + ['./lib/xtables/' + n for n in builder.EXTENSIONS]
            else:
                names = [
                    './lib/libxtables.so.10.0.0',
                    './usr/share/doc/libxtables10/copyright',
                ]
            b = io.BytesIO()
            with tarfile.open(fileobj=b, mode='w:gz') as t:
                for n in names + ['../../escape']:
                    d = n.encode()
                    i = tarfile.TarInfo(n)
                    i.size = len(d)
                    t.addfile(i, io.BytesIO(d))
            data = b.getvalue()
            suffix = '.tgz'
            if name != 'tailscale':
                suffix = '.deb'
                h = f'{"data.tar.gz/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode()
                data = b'!<arch>\n' + h + data + (b'\n' if len(data) % 2 else b'')
            (self.cache / (name + suffix)).write_bytes(data)
            item['sha256'] = builder.sha(data)
        (self.source / 'device/vendor.lock.json').write_text(json.dumps(lock))

    def build(self):
        return builder.build(self.cache, self.output, root=self.source)

    def test_candidate_gated_archives_and_case_preservation(self):
        m = self.build()
        self.assertEqual(m['channel'], 'candidate')
        self.assertFalse(m['profile']['bootstrapAccepted'])
        self.assertFalse((self.root / 'escape').exists())
        with tarfile.open(self.output / 'payload/lib/xtables.tar') as t:
            self.assertEqual(set(t.getnames()), set(builder.EXTENSIONS))
            self.assertNotEqual(
                t.extractfile('libxt_MARK.so').read(),
                t.extractfile('libxt_mark.so').read(),
            )
        for n in ['bootstrap.tgz', 'recovery.tgz']:
            with tarfile.open(self.output / n) as t:
                self.assertEqual(
                    set(t.getnames()),
                    {
                        'usr/local/kobold-0.1.0/bootstrap.sh',
                        'usr/local/kobold-0.1.0/controller.sh',
                        'etc/udev/rules.d/98-kobold-0.1.0.rules',
                        'usr/local/kobold-0.1.0/provenance',
                        'usr/local/kobold-0.1.0/release.json',
                        'usr/local/kobold-0.1.0/release-keys.json',
                        'usr/local/kobold-0.1.0/GO-LICENSE.txt',
                    },
                )
                self.assertTrue(all(x.isfile() for x in t))
                controller = t.extractfile(
                    'usr/local/kobold-0.1.0/controller.sh'
                ).read()
                self.assertNotIn(b'@MANIFEST_SHA@', controller)
        for f in m['files']:
            self.assertEqual(
                builder.sha((self.output / f['url']).read_bytes()), f['sha256']
            )
            self.assertEqual(
                (self.output / 'objects' / f['sha256']).read_bytes(),
                (self.output / f['url']).read_bytes(),
            )

    def test_signed_package_and_device_receipt_interoperate_with_browser_crypto(self):
        key = self.root / 'fixture-private.pem'
        trust = self.root / 'fixture-trust.json'
        subprocess.run(
            [
                'node',
                '--input-type=module',
                '-e',
                "import{generateKeyPairSync}from'node:crypto';import{writeFileSync}from'node:fs';const{privateKey,publicKey}=generateKeyPairSync('ed25519');writeFileSync(process.argv[1],privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});writeFileSync(process.argv[2],JSON.stringify({fixture:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')}));",
                str(key),
                str(trust),
            ],
            check=True,
            capture_output=True,
        )
        import datetime

        preflight = {
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'profileId': 'libra-colour-390-4.46.23836',
            'architecture': 'armv7l',
            'kernel': '4.9.77',
            'absentRootPaths': list(builder.TRIAL_PATHS),
            'parentsAreRealDirectories': True,
            'identitySha256': builder.sha(
                b'N428-FAKE,4.9.77,4.46.23836,x,y,000000000390'
            ),
            'systemBackupSha256': 'b' * 64,
            'systemBackupSize': 100,
            'rootFreeBytes': 10**9,
            'onboardFreeBytes': 10**9,
        }
        m = builder.build(
            self.cache,
            self.output,
            root=self.source,
            signing_key=key,
            trust=trust,
            inspect_only=True,
            preflight=preflight,
        )
        self.assertEqual(m['channel'], 'attended-trial')
        self.assertFalse(m['profile']['bootstrapAccepted'])
        fake = self.root / 'fake'
        fake.mkdir()
        (fake / '.kobold-test-root').touch()
        with tarfile.open(self.output / 'bootstrap.tgz') as archive:
            archive.extractall(fake, filter='data')
        home = fake / 'mnt/onboard/.adds/kobold'
        shutil.copytree(self.output / 'payload', home / 'releases/0.1.0')
        version = fake / 'mnt/onboard/.kobo/version'
        version.parent.mkdir()
        version.write_text('N428-FAKE,4.9.77,4.46.23836,x,y,000000000390')
        host = self.root / 'host-provenance'
        go = (
            os.environ.get('KOBOLD_GO')
            or shutil.which('go')
            or str(ROOT / 'cache/toolchain/go/bin/go')
        )
        env = {
            **os.environ,
            'GOTOOLCHAIN': 'local',
            'GOCACHE': str(Path(tempfile.gettempdir()) / 'kobold-go-build-cache'),
        }
        subprocess.run(
            [go, 'build', '-o', str(host), '.'],
            cwd=ROOT / 'device/provenance',
            env=env,
            check=True,
            capture_output=True,
        )
        nonce = 'a' * 32
        report = home / 'reports' / nonce
        report.mkdir(parents=True)
        (report / 'system-backup.sha256').write_text('b' * 64)
        subprocess.run(
            [str(host), 'inspect', nonce],
            env={**env, 'KS_TEST_ROOT': str(fake)},
            check=True,
            capture_output=True,
        )
        script = "import{readFileSync as read}from'node:fs';import{verifyEnvelope,verifyReleaseEnvelope}from'./web/lib/provenance.js';const manifest=await verifyReleaseEnvelope(JSON.parse(read(process.argv[1])),JSON.parse(read(process.argv[2])));const env=JSON.parse(read(process.argv[3]));const receipt=(await verifyEnvelope(env,{[env.keyId]:env.keyId})).value;if(receipt.status!=='prepared'||receipt.release!==manifest.installationDescriptorSha256||!receipt.reportFiles['system-backup.sha256'])throw Error('receipt mismatch');"
        subprocess.run(
            [
                'node',
                '--input-type=module',
                '-e',
                script,
                str(self.output / 'manifest.signed.json'),
                str(trust),
                str(report / 'installation.json'),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
        )
        self.assertEqual(
            (fake / 'usr/local/kobold-state/installation.json').stat().st_mode & 0o777,
            0o600,
        )
        self.assertTrue(all('private' not in f['path'] for f in m['files']))

    def test_full_install_trial_enables_controller_without_promoting_hardware(self):
        with self.assertRaisesRegex(ValueError, 'requires a signer'):
            builder.build(self.cache, self.output, root=self.source, connect_trial=True)
        key = self.root / 'fixture-private.pem'
        trust = self.root / 'fixture-trust.json'
        subprocess.run(
            [
                'node',
                '--input-type=module',
                '-e',
                "import{generateKeyPairSync}from'node:crypto';import{writeFileSync}from'node:fs';const{privateKey,publicKey}=generateKeyPairSync('ed25519');writeFileSync(process.argv[1],privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});writeFileSync(process.argv[2],JSON.stringify({fixture:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')}));",
                str(key),
                str(trust),
            ],
            check=True,
            capture_output=True,
        )
        collection = {'id': 'c' * 32, 'descriptorSha256': 'd' * 64}
        with self.assertRaisesRegex(ValueError, 'requires a signer'):
            builder.build(
                self.cache,
                self.output,
                root=self.source,
                connect_trial=True,
                inspect_only=True,
                signing_key=key,
                trust=trust,
                collection=collection,
            )
        m = builder.build(
            self.cache,
            self.output,
            root=self.source,
            connect_trial=True,
            signing_key=key,
            trust=trust,
            collection=collection,
        )
        self.assertEqual(m['jobProtocol'], 2)
        self.assertEqual(m['channel'], 'attended-trial')
        self.assertEqual(m['trial']['purpose'], 'install-and-connect')
        self.assertFalse(m['profile']['bootstrapAccepted'])
        self.assertNotIn('continuation', m)
        import base64

        with tarfile.open(self.output / 'bootstrap.tgz') as archive:
            controller = archive.extractfile(
                'usr/local/kobold-0.1.0/controller.sh'
            ).read()
            self.assertIn(b'trial_only=false', controller)
            self.assertIn(b'job-recover', controller)
            self.assertIn(b'job-begin', controller)
            self.assertIn(b'job-finish', controller)
            descriptor = json.loads(
                base64.b64decode(
                    json.loads(
                        archive.extractfile(
                            'usr/local/kobold-0.1.0/release.json'
                        ).read()
                    )['payload']
                )
            )
            self.assertEqual(descriptor['purpose'], 'install')
        for f in m['files']:
            self.assertEqual(
                builder.sha((self.output / 'objects' / f['sha256']).read_bytes()),
                f['sha256'],
            )

    def test_inspect_only_preview_does_not_promote_hardware_acceptance(self):
        m = builder.build(self.cache, self.output, root=self.source, inspect_only=True)
        self.assertEqual(m['channel'], 'trial-preview')
        self.assertFalse(m['profile']['bootstrapAccepted'])
        with tarfile.open(self.output / 'bootstrap.tgz') as archive:
            script = archive.extractfile('usr/local/kobold-0.1.0/controller.sh').read()
            self.assertIn(b'trial_only=true', script)
            self.assertNotIn(b'@TRIAL_ONLY@', script)

    def test_preflight_requires_recent_runtime_namespace_and_capacity_evidence(self):
        import datetime

        record = {
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'profileId': 'libra-colour-390-4.46.23836',
            'architecture': 'armv7l',
            'kernel': '4.9.77',
            'absentRootPaths': list(builder.TRIAL_PATHS),
            'parentsAreRealDirectories': True,
            'identitySha256': 'a' * 64,
            'systemBackupSha256': 'b' * 64,
            'systemBackupSize': 100,
            'rootFreeBytes': 10**9,
            'onboardFreeBytes': 10**9,
        }
        self.assertTrue(builder.trial_preflight(record, 100, 100))
        for key, value in [
            ('architecture', 'aarch64'),
            ('absentRootPaths', []),
            ('parentsAreRealDirectories', False),
            ('rootFreeBytes', 1),
            ('systemBackupSize', 0),
            ('observedAt', '2020-01-01T00:00:00Z'),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                builder.trial_preflight({**record, key: value}, 100, 100)

    def test_root_archive_is_reproducible(self):
        self.assertEqual(
            builder.archive({'x.sh': b'echo hello'}),
            builder.archive({'x.sh': b'echo hello'}),
        )

    def test_corrupt_vendor_never_creates_output(self):
        (self.cache / 'firewall.deb').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_output_collision_and_unsubstantiated_promotion_refused(self):
        self.output.mkdir()
        (self.output / 'keep').write_text('keep')
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual((self.output / 'keep').read_text(), 'keep')
        shutil.rmtree(self.output)
        p = self.source / 'device/profile.json'
        profile = json.loads(p.read_text())
        profile['bootstrapAccepted'] = True
        p.write_text(json.dumps(profile))
        with self.assertRaisesRegex(ValueError, 'evidence'):
            self.build()

    def test_missing_module_leaves_no_partial_release(self):
        original = builder.EXTENSIONS
        builder.EXTENSIONS = original + ('missing.so',)
        try:
            with self.assertRaises(KeyError):
                self.build()
        finally:
            builder.EXTENSIONS = original
        self.assertFalse(self.output.exists())


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        (self.root / '.kobold-test-root').touch()
        self.home = self.root / 'mnt/onboard/.adds/kobold'
        self.home.mkdir(parents=True)
        (self.root / 'tmp').mkdir()
        (self.root / 'etc/udev/rules.d').mkdir(parents=True)
        (self.root / 'mnt/onboard/.kobo').mkdir()
        self.version = self.root / 'mnt/onboard/.kobo/version'
        self.version.write_text('N428-FAKE,kernel,4.46.23836,x,y,000000000390')
        self.book = self.root / 'mnt/onboard/book.epub'
        self.book.write_bytes(b'KEEP BOOK')
        self.config = self.root / 'mnt/onboard/.kobo/config'
        self.config.write_bytes(b'KEEP SETTINGS')
        (self.home / 'state').mkdir()
        self.identity = self.home / 'state/tailscaled.state'
        self.identity.write_bytes(b'KEEP IDENTITY')
        self.rule = self.root / 'etc/udev/rules.d/98-kobold-0.1.0.rules'
        self.rule.write_text('owned rule')
        self.script = self.root / 'controller.sh'
        text = (
            (ROOT / 'device/controller.sh')
            .read_text()
            .replace('@RULE_SHA@', builder.sha(self.rule.read_bytes()))
        )
        self.script.write_text(text)

    def request(self, action='inspect', extra=''):
        (self.home / 'request.txt').write_text(
            'id='
            + ('a' * 32)
            + '\naction='
            + action
            + '\nprofile=libra-colour-390-4.46.23836\nhostname=kobo-reader\ntag=tag:kobo-sync\n'
            + extra
        )

    def run_job(self):
        r = subprocess.run(
            ['sh', str(self.script)],
            env={**os.environ, 'KS_TEST_ROOT': str(self.root)},
            capture_output=True,
            text=True,
        )
        self.assertEqual(self.book.read_bytes(), b'KEEP BOOK')
        self.assertEqual(self.config.read_bytes(), b'KEEP SETTINGS')
        self.assertEqual(self.identity.read_bytes(), b'KEEP IDENTITY')
        return r

    def test_inspect_snapshots_without_native_execution_and_is_not_replayed(self):
        self.request()
        r = self.run_job()
        self.assertEqual(r.returncode, 0, r.stderr)
        with tarfile.open(self.home / 'system-backup.tar.gz') as t:
            self.assertIn('etc/udev/rules.d/98-kobold-0.1.0.rules', t.getnames())
        self.assertFalse((self.home / 'request.txt').exists())
        self.assertFalse((self.root / 'tmp/kobold-controller/lock').exists())
        self.assertEqual(self.run_job().returncode, 0)

    def test_usb_storage_disappearance_exposes_consumed_job_without_result(self):
        # Host-only fault injection, not ARM execution or hardware acceptance.
        # Preserve the original tree outside its mount path to model USB export.
        self.request()
        (self.home / 'last-result.txt').write_text('b' * 32 + '\n')
        tools = self.root / 'host-tools'
        tools.mkdir()
        tar = tools / 'tar'
        tar.write_text(
            '#!/bin/sh\nmv "$KS_TEST_ROOT/mnt/onboard" "$KS_TEST_ROOT/exported"\nexit 1\n'
        )
        tar.chmod(0o700)
        result = subprocess.run(
            ['sh', str(self.script)],
            env={
                **os.environ,
                'KS_TEST_ROOT': str(self.root),
                'PATH': str(tools) + os.pathsep + os.environ['PATH'],
            },
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        exported = self.root / 'exported'
        home = exported / '.adds/kobold'
        self.assertFalse((home / 'request.txt').exists())
        self.assertTrue((home / 'reports' / ('a' * 32) / 'request.txt').exists())
        self.assertFalse((home / 'reports' / ('a' * 32) / 'result.txt').exists())
        self.assertEqual((home / 'last-result.txt').read_text(), 'b' * 32 + '\n')
        self.assertEqual((exported / 'book.epub').read_bytes(), b'KEEP BOOK')
        self.assertEqual((exported / '.kobo/config').read_bytes(), b'KEEP SETTINGS')
        self.assertEqual(
            (home / 'state/tailscaled.state').read_bytes(), b'KEEP IDENTITY'
        )

    def test_inspect_trial_refuses_all_connection_actions_before_consuming_requests(
        self,
    ):
        self.script.write_text(self.script.read_text().replace('@TRIAL_ONLY@', 'true'))
        for action in ['enrol', 'status', 'enable']:
            self.request(action)
            result = self.run_job()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Inspect-only trial', result.stderr)
            self.assertTrue((self.home / 'request.txt').exists())
        self.request('inspect')
        self.assertEqual(self.run_job().returncode, 0)

    def test_unknown_and_duplicate_requests_never_execute(self):
        for action, extra in [
            ('reboot', ''),
            ('inspect', 'action=uninstall\n'),
            ('inspect', 'evil=$(reboot)\n'),
        ]:
            self.request(action, extra)
            self.assertNotEqual(self.run_job().returncode, 0)
            self.assertTrue(self.rule.exists())
            self.assertFalse((self.home / 'system-backup.tar.gz').exists())

    def test_wrong_firmware_blocks_install_actions_but_allows_disable(self):
        self.version.write_text('N428-FAKE,kernel,9.0.0,x,y,000000000390')
        self.request()
        self.assertNotEqual(self.run_job().returncode, 0)
        (self.home / 'state/autostart').touch()
        self.request('disable')
        self.assertEqual(self.run_job().returncode, 0)
        self.assertFalse((self.home / 'state/autostart').exists())

    def test_foreign_rule_is_preserved_by_uninstall(self):
        self.rule.write_text('foreign')
        self.request('uninstall')
        self.assertNotEqual(self.run_job().returncode, 0)
        self.assertEqual(self.rule.read_text(), 'foreign')

    def test_owned_uninstall_preserves_identity_books_and_root_controller(self):
        self.request('uninstall')
        self.assertEqual(self.run_job().returncode, 0)
        self.assertFalse(self.rule.exists())
        self.assertTrue(self.script.exists())

    def test_symlink_managed_paths_are_refused(self):
        (self.home / 'request.txt').symlink_to(self.config)
        self.assertNotEqual(self.run_job().returncode, 0)

    def test_enrol_never_executes_vendor_code_in_fake_root(self):
        self.request('enrol')
        self.assertNotEqual(self.run_job().returncode, 0)


if __name__ == '__main__':
    unittest.main()
