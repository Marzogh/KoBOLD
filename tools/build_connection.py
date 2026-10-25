#!/usr/bin/env python3
"""Create an isolated connection continuation from an exact signed inspect trial."""

import argparse
import base64
import copy
import io
import json
import secrets
import shutil
import subprocess
import tarfile
from pathlib import Path
from build import ROOT, archive, sha, helper, signed


def build_connection(previous, output, key, retry_site=None, managed_upgrade=False):
    """Bind a reversible update to the exact signed previous root inventory."""
    if output.exists():
        raise ValueError('Connection output exists')
    if key.resolve().is_relative_to(ROOT):
        raise ValueError('Keep the private signer outside the repository')
    trust = previous / 'trust/release-keys.json'
    old = json.loads((previous / 'releases/0.1.0/manifest.json').read_text())
    env = json.loads((previous / 'releases/0.1.0/manifest.signed.json').read_text())
    verify = "import{readFileSync as r}from'node:fs';import{verify}from'node:crypto';const e=JSON.parse(r(process.argv[1])),keys=JSON.parse(r(process.argv[2]));const raw=Buffer.from(keys[e.keyId]??'','base64');if(raw.length!==32||!verify(null,Buffer.from(e.payload,'base64'),{key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),format:'der',type:'spki'},Buffer.from(e.signature,'base64')))throw Error('Previous release is not authenticated');"
    subprocess.run(
        [
            'node',
            '--input-type=module',
            '-e',
            verify,
            str(previous / 'releases/0.1.0/manifest.signed.json'),
            str(trust),
        ],
        check=True,
        capture_output=True,
    )
    if json.loads(base64.b64decode(env['payload'])) != old or old['channel'] not in (
        ['attended-trial', 'connection-trial', 'tested']
        if managed_upgrade
        else ['attended-trial']
    ):
        raise ValueError('Expected the exact previous inspect trial')
    archive_name = (
        'recovery.tgz'
        if managed_upgrade and old['channel'] in ('connection-trial', 'tested')
        else 'bootstrap.tgz'
    )
    blob = (previous / 'releases/0.1.0' / archive_name).read_bytes()
    if sha(blob) != old['updates'][archive_name]['sha256']:
        raise ValueError('Previous archive checksum failed')
    with tarfile.open(fileobj=io.BytesIO(blob)) as t:
        old_files = {m.name: t.extractfile(m).read() for m in t if m.isfile()}
    expected = {
        'usr/local/kobold-0.1.0/' + n
        for n in [
            'bootstrap.sh',
            'controller.sh',
            'provenance',
            'release.json',
            'release-keys.json',
            'GO-LICENSE.txt',
        ]
    } | {'etc/udev/rules.d/98-kobold-0.1.0.rules'}
    if set(old_files) != expected:
        raise ValueError('Unexpected previous root file inventory')
    root_descriptor = json.loads(
        base64.b64decode(
            json.loads(old_files['usr/local/kobold-0.1.0/release.json'])['payload']
        )
    )
    if (
        sha(
            base64.b64decode(
                json.loads(old_files['usr/local/kobold-0.1.0/release.json'])['payload']
            )
        )
        != old['installationDescriptorSha256']
    ):
        raise ValueError('Previous root descriptor does not match installed release')
    if root_descriptor.get('purpose') not in (
        ['install', 'connection-trial'] if managed_upgrade else ['inspect-only']
    ):
        raise ValueError('Previous root package is not inspect-only')
    next_files = dict(old_files)
    binary = helper(ROOT)
    payload_dir = previous / 'releases/0.1.0/payload'
    payload_files = {
        f['path']: (payload_dir / f['path']).read_bytes() for f in old['files']
    }
    for f in old['files']:
        if sha(payload_files[f['path']]) != f['sha256']:
            raise ValueError('Previous payload changed')
    payload_files['runtime.sh'] = (ROOT / 'device/runtime.sh').read_bytes()
    payload_files['probe.sh'] = (ROOT / 'device/probe.sh').read_bytes()
    payload_files['SHA256SUMS'] = ''.join(
        sha(data) + '  ' + name + '\n'
        for name, data in sorted(payload_files.items())
        if name != 'SHA256SUMS'
    ).encode()
    if managed_upgrade:
        if any(
            payload_files[name] != (payload_dir / name).read_bytes()
            for name in ['runtime.sh', 'probe.sh', 'SHA256SUMS']
        ):
            raise ValueError(
                'This managed protocol update must preserve the USB payload exactly'
            )
    else:
        for name in ['runtime.sh', 'probe.sh', 'SHA256SUMS']:
            next_files['mnt/onboard/.adds/kobold/releases/0.1.0/' + name] = (
                payload_files[name]
            )
        old_files.update(
            {
                'mnt/onboard/.adds/kobold/releases/0.1.0/' + name: (
                    payload_dir / name
                ).read_bytes()
                for name in ['runtime.sh', 'probe.sh', 'SHA256SUMS']
            }
        )
    next_files['usr/local/kobold-0.1.0/provenance'] = binary
    rule = old_files['etc/udev/rules.d/98-kobold-0.1.0.rules']
    next_files['usr/local/kobold-0.1.0/controller.sh'] = (
        (ROOT / 'device/controller.sh')
        .read_text()
        .replace('@TRIAL_ONLY@', 'false')
        .replace('@MANIFEST_SHA@', sha(payload_files['SHA256SUMS']))
        .replace('@RULE_SHA@', sha(rule))
        .encode()
    )
    descriptor = copy.deepcopy(root_descriptor)
    descriptor['purpose'] = 'connection-trial'
    for name, data in next_files.items():
        if name.endswith('/release.json'):
            continue
        descriptor['files']['/' + name] = sha(data)
    payload = json.dumps(descriptor, sort_keys=True, separators=(',', ':')).encode()
    next_files['usr/local/kobold-0.1.0/release.json'] = signed(payload, key, trust)
    retry = None
    if retry_site:
        retry = json.loads((retry_site / 'releases/0.1.0/manifest.json').read_text())
        subprocess.run(
            [
                'node',
                '--input-type=module',
                '-e',
                verify,
                str(retry_site / 'releases/0.1.0/manifest.signed.json'),
                str(trust),
            ],
            check=True,
            capture_output=True,
        )
        signed_retry = json.loads(
            base64.b64decode(
                json.loads(
                    (retry_site / 'releases/0.1.0/manifest.signed.json').read_text()
                )['payload']
            )
        )
        if (
            signed_retry != retry
            or retry.get('continuation', {}).get('previous') != old
        ):
            raise ValueError('Retry does not refer to this exact inspected release')
    identifier = retry['continuation']['id'] if retry else secrets.token_hex(16)
    base = 'usr/local/kobold-connect-' + identifier
    bridge_rule = 'etc/udev/rules.d/97-kobold-connect-' + identifier + '.rules'
    bootstrap = (
        (ROOT / 'device/bootstrap.sh')
        .read_text()
        .replace(
            'exec /bin/sh /usr/local/kobold-0.1.0/controller.sh',
            'exec /' + base + '/provenance connect ' + identifier,
        )
    )
    files = {
        base + '/bootstrap.sh': bootstrap.encode(),
        base + '/provenance': binary,
        bridge_rule: (
            'KERNEL=="loop0", ACTION=="add", RUN+="/bin/sh /'
            + base
            + '/bootstrap.sh"\nKERNEL=="wlan*", ACTION=="add", RUN+="/bin/sh /'
            + base
            + '/bootstrap.sh"\n'
        ).encode(),
    }
    authorization = {
        'purpose': 'upgrade-managed-install'
        if managed_upgrade
        else 'continue-inspected-install',
        'id': identifier,
        'previousDescriptor': old['installationDescriptorSha256'],
        'nextDescriptor': sha(payload),
        'oldFiles': {'/' + n: sha(d) for n, d in old_files.items()},
        'newFiles': {'/' + n: sha(d) for n, d in next_files.items()},
        'bridgeFiles': {'/' + n: sha(d) for n, d in files.items()},
    }
    if retry:
        authorization['metadataRetry'] = True
    auth = signed(
        json.dumps(authorization, sort_keys=True, separators=(',', ':')).encode(),
        key,
        trust,
    )
    files[base + '/authorization.json'] = auth
    for name, data in next_files.items():
        files[base + '/next/' + name] = data
    data = archive(files)
    new = copy.deepcopy(old)
    new['channel'] = 'connection-trial'
    new['jobProtocol'] = 2
    new['installationDescriptorSha256'] = sha(payload)
    new.pop('trial', None)
    new['manifestSha256'] = sha(payload_files['SHA256SUMS'])
    new['files'] = [
        {
            **f,
            'size': len(payload_files[f['path']]),
            'sha256': sha(payload_files[f['path']]),
        }
        for f in old['files']
    ]
    recovery_data = archive(next_files)
    new['updates']['recovery.tgz'] = {
        'url': 'recovery.tgz',
        'size': len(recovery_data),
        'sha256': sha(recovery_data),
    }
    new['continuation'] = {
        'purpose': authorization['purpose'],
        'id': identifier,
        'previous': old,
        'archive': {'url': 'connection.tgz', 'size': len(data), 'sha256': sha(data)},
        'authorizationSha256': sha(auth),
        'rootFiles': sorted('/' + n for n in files),
    }
    if retry:
        new['continuation']['retry'] = {
            'reason': 'host-metadata',
            'descriptor': retry['installationDescriptorSha256'],
        }
    output.mkdir(parents=True)
    site = output / 'site'
    shutil.copytree(
        ROOT / 'web',
        site,
        ignore=shutil.ignore_patterns('releases', 'dev', 'backup-check.html'),
    )
    shutil.copytree(previous / 'releases', site / 'releases')
    shutil.copyfile(trust, site / 'trust/release-keys.json')
    if (previous / 'collection').exists():
        shutil.copytree(previous / 'collection', site / 'collection')
        shutil.copyfile(
            previous / 'trust/collection-keys.json', site / 'trust/collection-keys.json'
        )
    release = site / 'releases/0.1.0'
    for name in ['runtime.sh', 'probe.sh', 'SHA256SUMS']:
        (release / 'payload' / name).write_bytes(payload_files[name])
    (release / 'connection.tgz').write_bytes(data)
    (release / 'recovery.tgz').write_bytes(recovery_data)
    (release / 'connection-authorization.json').write_bytes(auth)
    (release / 'manifest.json').write_text(json.dumps(new, indent=2) + '\n')
    (release / 'manifest.signed.json').unlink()
    (release / 'manifest.signed.json').write_bytes(
        signed((release / 'manifest.json').read_bytes(), key, trust)
    )
    objects = release / 'objects'
    objects.mkdir(exist_ok=True)
    for f in old['files']:
        blob = (payload_dir / f['path']).read_bytes()
        (objects / f['sha256']).write_bytes(blob)
    for blob in payload_files.values():
        (objects / sha(blob)).write_bytes(blob)
    (output / 'CONNECTION-REVIEW.json').write_text(
        json.dumps(
            {
                'id': identifier,
                'from': authorization['previousDescriptor'],
                'to': authorization['nextDescriptor'],
                'archive': new['continuation']['archive'],
                'rootFiles': new['continuation']['rootFiles'],
                'deviceChangesApproved': False,
            },
            indent=2,
        )
        + '\n'
    )
    return new


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--previous-site', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--signing-key', type=Path, required=True)
    p.add_argument('--retry-site', type=Path)
    p.add_argument('--managed-upgrade', action='store_true')
    a = p.parse_args()
    m = build_connection(
        a.previous_site,
        a.output,
        a.signing_key,
        a.retry_site,
        managed_upgrade=a.managed_upgrade,
    )
    print(
        json.dumps({'channel': m['channel'], 'archive': m['continuation']['archive']})
    )
