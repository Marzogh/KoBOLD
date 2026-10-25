#!/usr/bin/env python3
"""Produce a static Pages release. Never execute vendor code or device jobs."""

import datetime
import argparse
import gzip
import hashlib
import io
import json
import shutil
import tarfile
import urllib.request
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSIONS = (
    'libxt_standard.so',
    'libxt_MARK.so',
    'libxt_mark.so',
    'libxt_CONNMARK.so',
    'libxt_connmark.so',
    'libxt_conntrack.so',
    'libxt_tcp.so',
    'libxt_udp.so',
    'libxt_TCPMSS.so',
    'libxt_statistic.so',
    'libipt_MASQUERADE.so',
    'libip6t_MASQUERADE.so',
    'libipt_DNAT.so',
    'libip6t_DNAT.so',
    'libipt_SNAT.so',
    'libip6t_SNAT.so',
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def deb_data(path):
    with path.open('rb') as f:
        if f.read(8) != b'!<arch>\n':
            raise ValueError('Invalid Debian archive')
        while h := f.read(60):
            if len(h) != 60 or h[58:] != b'`\n':
                raise ValueError('Invalid Debian header')
            n = int(h[48:58])
            data = f.read(n)
            if len(data) != n:
                raise ValueError('Truncated Debian archive')
            if n % 2:
                f.read(1)
            if h[:16].strip().rstrip(b'/') in (b'data.tar.gz', b'data.tar.xz'):
                return io.BytesIO(data)
    raise ValueError('Missing Debian data archive')


def member(path, name):
    with (
        tarfile.open(fileobj=deb_data(path))
        if path.suffix == '.deb'
        else tarfile.open(path) as t
    ):
        m = t.getmember(name)
        if not m.isfile():
            raise ValueError('Only exact regular members are allowed')
        return t.extractfile(m).read()


def archive(files):
    """Create a deterministic regular-file archive with no absolute or parent paths."""
    b = io.BytesIO()
    with tarfile.open(fileobj=b, mode='w', format=tarfile.USTAR_FORMAT) as t:
        for path, data in sorted(files.items()):
            if path.startswith('/') or '..' in Path(path).parts:
                raise ValueError('Unsafe archive path')
            info = tarfile.TarInfo(path)
            info.size = len(data)
            info.mode = (
                0o755 if path.endswith('.sh') or path.endswith('/provenance') else 0o644
            )
            t.addfile(info, io.BytesIO(data))
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode='wb', filename='', mtime=0) as gz:
        gz.write(b.getvalue())
    return compressed.getvalue()


def signed(data, key, trust):
    if not key:
        return json.dumps({'unsigned': True}).encode()
    with tempfile.TemporaryDirectory() as temp:
        source = Path(temp) / 'input'
        dest = Path(temp) / 'signed'
        source.write_bytes(data)
        subprocess.run(
            [
                'node',
                str(ROOT / 'tools/sign-release.mjs'),
                str(key),
                str(source),
                str(dest),
                str(trust),
            ],
            check=True,
            capture_output=True,
        )
        return dest.read_bytes()


def helper(root):
    """Cross-compile the fixed ARM helper; do not run it on the build host."""
    go = (
        os.environ.get('KOBOLD_GO')
        or shutil.which('go')
        or str(ROOT / 'cache/toolchain/go/bin/go')
    )
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / 'provenance'
        subprocess.run(
            [
                go,
                'build',
                '-trimpath',
                '-buildvcs=false',
                '-ldflags=-s -w -buildid=',
                '-o',
                str(output),
                '.',
            ],
            cwd=root / 'device/provenance',
            env={
                **os.environ,
                'GOOS': 'linux',
                'GOARCH': 'arm',
                'GOARM': '7',
                'CGO_ENABLED': '0',
                'GOTOOLCHAIN': 'local',
                'GOCACHE': os.environ.get(
                    'GOCACHE',
                    str(Path(tempfile.gettempdir()) / 'kobold-go-build-cache'),
                ),
            },
            check=True,
            capture_output=True,
        )
        return output.read_bytes()


TRIAL_PATHS = (
    '/usr/local/kobold-0.1.0',
    '/usr/local/kobold-state',
    '/etc/udev/rules.d/98-kobold-0.1.0.rules',
)


def trial_preflight(record, root_bytes, onboard_bytes):
    observed = datetime.datetime.fromisoformat(
        record['observedAt'].replace('Z', '+00:00')
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    if observed.tzinfo is None or not 0 <= (now - observed).total_seconds() < 7200:
        raise ValueError('Trial preflight must be observed within two hours')
    if (
        record.get('profileId') != 'libra-colour-390-4.46.23836'
        or record.get('architecture') != 'armv7l'
        or not record.get('kernel', '').startswith('4.9.77')
    ):
        raise ValueError('Trial runtime profile mismatch')
    if (
        record.get('absentRootPaths') != list(TRIAL_PATHS)
        or record.get('parentsAreRealDirectories') is not True
    ):
        raise ValueError(
            'Trial root namespace is not verified empty with real directory parents'
        )
    for key in ['identitySha256', 'systemBackupSha256']:
        value = record.get(key, '')
        if len(value) != 64 or any(c not in 'abcdef0123456789' for c in value):
            raise ValueError('Invalid trial preflight hash')
    for key, minimum in [
        ('rootFreeBytes', root_bytes + 16 * 1024 * 1024),
        ('onboardFreeBytes', onboard_bytes + 32 * 1024 * 1024),
        ('systemBackupSize', 1),
    ]:
        if type(record.get(key)) is not int or record[key] < minimum:
            raise ValueError('Insufficient or unknown trial ' + key)
    return (observed + datetime.timedelta(hours=2)).isoformat()


def build(
    cache,
    output,
    download=False,
    root=ROOT,
    signing_key=None,
    trust=None,
    inspect_only=False,
    preflight=None,
    collection=None,
    connect_trial=False,
):
    """Verify pinned inputs and write a new release directory without overwriting one."""
    if output.exists():
        raise ValueError('Output exists; never overwrite a prepared release')
    if connect_trial and (
        inspect_only or not signing_key or not (preflight or collection)
    ):
        raise ValueError(
            'Install-and-connect trial requires a signer, preflight or collection, and no inspect-only flag'
        )
    inspection = inspect_only or bool(preflight and not connect_trial)
    lock = json.loads((root / 'device/vendor.lock.json').read_text())
    inputs = {}
    cache.mkdir(parents=True, exist_ok=True)
    for name, spec in lock.items():
        p = cache / (name + ('.deb' if spec.get('format') == 'deb' else '.tgz'))
        if not p.exists():
            if not download:
                raise ValueError(
                    'Missing cached input ' + name + '; use --download explicitly'
                )
            data = urllib.request.urlopen(spec['url'], timeout=60).read()
            if sha(data) != spec['sha256']:
                raise ValueError('Download checksum mismatch: ' + name)
            p.write_bytes(data)
        if sha(p.read_bytes()) != spec['sha256']:
            raise ValueError('Cached checksum mismatch: ' + name)
        inputs[name] = p
    payload = {}
    for n in ['tailscale', 'tailscaled']:
        payload['bin/' + n] = member(
            inputs['tailscale'],
            'tailscale_' + lock['tailscale']['version'] + '_arm/' + n,
        )
    payload['libexec/iptables'] = member(inputs['firewall'], './sbin/xtables-multi')
    payload['libexec/ip6tables'] = payload['libexec/iptables']
    for name in ['libip4tc.so.0.1.0', 'libip6tc.so.0.1.0']:
        payload['lib/' + name.rsplit('.', 2)[0]] = member(
            inputs['firewall'], './lib/' + name
        )
    payload['lib/libxtables.so.10'] = member(
        inputs['firewall_xtables'], './lib/libxtables.so.10.0.0'
    )
    # A tar preserves MARK/mark on case-insensitive Mac and FAT storage.
    b = io.BytesIO()
    with tarfile.open(fileobj=b, mode='w', format=tarfile.USTAR_FORMAT) as t:
        for name in EXTENSIONS:
            data = member(inputs['firewall'], './lib/xtables/' + name)
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            t.addfile(info, io.BytesIO(data))
    payload['lib/xtables.tar'] = b.getvalue()
    for name in ['runtime.sh', 'probe.sh']:
        payload[name] = (root / 'device' / name).read_bytes()
    for name in ['iptables', 'ip6tables']:
        payload['bin/' + name] = (root / 'device/iptables.sh').read_bytes()
    payload['vendor.lock.json'] = (root / 'device/vendor.lock.json').read_bytes()
    payload['licenses/TAILSCALE-LICENSE.txt'] = (
        root / 'device/TAILSCALE-LICENSE.txt'
    ).read_bytes()
    # Retain original licence notices from both GPL Debian packages.
    for package in ['firewall', 'firewall_xtables']:
        doc = 'iptables' if package == 'firewall' else 'libxtables10'
        payload['licenses/' + doc + '-copyright'] = member(
            inputs[package], './usr/share/doc/' + doc + '/copyright'
        )
    payload['SHA256SUMS'] = ''.join(
        sha(data) + '  ' + name + '\n' for name, data in sorted(payload.items())
    ).encode()
    rule = (root / 'device/98-kobold-0.1.0.rules').read_bytes()
    controller = (
        (root / 'device/controller.sh')
        .read_text()
        .replace('@MANIFEST_SHA@', sha(payload['SHA256SUMS']))
        .replace('@RULE_SHA@', sha(rule))
        .replace('@TRIAL_ONLY@', 'true' if inspection else 'false')
        .encode()
    )
    bootstrap = {
        'usr/local/kobold-0.1.0/bootstrap.sh': (
            root / 'device/bootstrap.sh'
        ).read_bytes(),
        'usr/local/kobold-0.1.0/controller.sh': controller,
        'etc/udev/rules.d/98-kobold-0.1.0.rules': rule,
    }
    # Recovery package adds a request consumer only. It never overwrites boot files,
    # libraries, credentials or onboard data. Owner must preserve its namespace.
    bootstrap['usr/local/kobold-0.1.0/provenance'] = helper(root)
    bootstrap['usr/local/kobold-0.1.0/GO-LICENSE.txt'] = (
        root / 'device/provenance/GO-LICENSE.txt'
    ).read_bytes()
    trust = trust or ROOT / 'web/trust/release-keys.json'
    bootstrap['usr/local/kobold-0.1.0/release-keys.json'] = trust.read_bytes()
    descriptor = {
        'purpose': 'inspect-only' if inspection else 'install',
        'installer': 'org.kobold.kobo-tailscale/v1',
        'profile': 'libra-colour-390-4.46.23836',
        'version': '0.1.0',
        'files': {('/' + name): sha(data) for name, data in bootstrap.items()},
    }
    descriptor['files'].update(
        {
            ('/mnt/onboard/.adds/kobold/releases/0.1.0/' + name): sha(data)
            for name, data in payload.items()
        }
    )
    bootstrap['usr/local/kobold-0.1.0/release.json'] = signed(
        json.dumps(descriptor, sort_keys=True, separators=(',', ':')).encode(),
        signing_key,
        trust,
    )
    recovery = dict(bootstrap)
    profile = json.loads((root / 'device/profile.json').read_text())
    if (inspect_only or preflight or connect_trial) and profile['bootstrapAccepted']:
        raise ValueError('An attended trial must not promote hardware acceptance')
    if profile['bootstrapAccepted']:
        evidence = profile.get('bootstrapEvidence')
        if (
            not isinstance(evidence, dict)
            or evidence.get('profileId') != profile['id']
            or evidence.get('archiveSha256') != sha(archive(bootstrap))
            or not evidence.get('date')
            or not evidence.get('record')
        ):
            raise ValueError(
                'Exact-archive hardware acceptance evidence is required to promote installation'
            )
    stage = output.with_name(output.name + '.building')
    if stage.exists():
        raise ValueError('Build staging directory already exists')
    stage.mkdir(parents=True)
    try:
        descriptions = []
        for name, data in sorted(payload.items()):
            p = stage / 'payload' / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            objects = stage / 'objects'
            objects.mkdir(exist_ok=True)
            (objects / sha(data)).write_bytes(data)
            descriptions.append(
                {
                    'path': name,
                    'url': 'payload/' + name,
                    'sha256': sha(data),
                    'size': len(data),
                }
            )
        updates = {}
        for name, files in [('bootstrap.tgz', bootstrap), ('recovery.tgz', recovery)]:
            data = archive(files)
            (stage / name).write_bytes(data)
            updates[name] = {'url': name, 'sha256': sha(data), 'size': len(data)}
        manifest = {
            'schema': 1,
            'namespace': 'kobold',
            'jobProtocol': 2,
            'version': '0.1.0',
            'channel': 'candidate' if not profile['bootstrapAccepted'] else 'tested',
            'profile': profile,
            'files': descriptions,
            'updates': updates,
            'manifestSha256': sha(payload['SHA256SUMS']),
            'installationDescriptorSha256': sha(
                json.dumps(descriptor, sort_keys=True, separators=(',', ':')).encode()
            ),
            'supplyChain': 'Pinned vendor SHA256 and optional offline Ed25519 release signature. Unsigned candidates cannot install.',
        }
        if collection:
            manifest['preflight'] = {
                'collection': {
                    'id': collection['id'],
                    'descriptorSha256': collection['descriptorSha256'],
                }
            }
        if inspect_only or preflight or connect_trial:
            manifest['channel'] = (
                'attended-trial'
                if (preflight or collection) and signing_key
                else 'trial-preview'
            )
            manifest['trial'] = {
                'purpose': 'install-and-connect' if connect_trial else 'inspect-only',
                'profileId': profile['id'],
                'bootstrapSha256': updates['bootstrap.tgz']['sha256'],
            }
            if collection:
                manifest['trial']['collection'] = {
                    'id': collection['id'],
                    'descriptorSha256': collection['descriptorSha256'],
                }
            if preflight:
                manifest['trial']['expires'] = trial_preflight(
                    preflight,
                    sum(map(len, bootstrap.values())),
                    sum(map(len, payload.values())) + 2 * len(archive(bootstrap)),
                )
                manifest['trial']['preflight'] = preflight
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (stage / 'manifest.signed.json').write_bytes(
            signed((stage / 'manifest.json').read_bytes(), signing_key, trust)
        )
        stage.rename(output)
    except BaseException:
        shutil.rmtree(stage)
        raise
    return manifest


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--cache', type=Path, default=ROOT / 'cache')
    p.add_argument('--output', type=Path, default=ROOT / 'web/releases/0.1.0')
    p.add_argument('--download', action='store_true')
    p.add_argument('--signing-key', type=Path)
    p.add_argument('--trust', type=Path)
    p.add_argument('--inspect-only', action='store_true')
    p.add_argument('--connect-trial', action='store_true')
    p.add_argument('--collection-manifest', type=Path)
    p.add_argument('--trial-preflight', type=Path)
    a = p.parse_args()
    m = build(
        a.cache,
        a.output,
        a.download,
        signing_key=a.signing_key,
        trust=a.trust,
        inspect_only=a.inspect_only,
        preflight=json.loads(a.trial_preflight.read_text())
        if a.trial_preflight
        else None,
        collection=json.loads(a.collection_manifest.read_text())
        if a.collection_manifest
        else None,
        connect_trial=a.connect_trial,
    )
    print(
        json.dumps(
            {
                'version': m['version'],
                'files': len(m['files']),
                'channel': m['channel'],
                'output': str(a.output),
            }
        )
    )
