#!/usr/bin/env python3
"""Create reviewed source/site snapshots from explicit file inventories.

Never copy Git history, private working records or a directory recursively.
Release bundles are added separately from authenticated, production-ready metadata.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from html.parser import HTMLParser
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / 'publication/files.json'
BLOCKED_PARTS = {'.git', '.agents', '.codex', '__pycache__', 'cache', 'node_modules'}
BLOCKED_NAMES = {'AGENTS.md', 'CURRENT-HANDOFF.md', 'README_for_Codex.md'}
TEXT_SUFFIXES = {
    '.js',
    '.mjs',
    '.py',
    '.go',
    '.json',
    '.md',
    '.txt',
    '.html',
    '.css',
    '.yml',
    '.sh',
    '.rules',
}
PRIVATE_PATH = re.compile(
    r'/(?:Users|home)/[A-Za-z0-9_.-]+/|/private/(?:tmp)/kobold-[^\s]+'
)
PRIVATE_KEY = re.compile(
    r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s*\n[A-Za-z0-9+/=]{32}'
)
AUTH_KEY = re.compile(r'tskey-(?:auth|api)-[A-Za-z0-9_-]{20,}')
INTERNAL_HEADING = re.compile(
    r'(?im)^#{1,6}\s+(?:Build in Codex|Current handoff|Agent instructions)\s*$'
)


def safe_path(value):
    """Accept a portable relative file name, never a traversal or hidden tree."""
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or '\\' in value
        or any(p in ('', '.', '..') for p in value.split('/'))
    ):
        raise ValueError('Unsafe publication path')
    if any(p in BLOCKED_PARTS for p in path.parts) or path.name in BLOCKED_NAMES:
        raise ValueError('Private file in publication inventory: ' + value)
    return path


def inspect_text(path, data):
    """Report categories and paths only, never a matched secret value."""
    if path.suffix not in TEXT_SUFFIXES and path.name not in {'LICENSE', '.gitignore'}:
        return
    text = data.decode('utf-8')
    if path.suffix == '.md' and re.search(
        r'(?:CURRENT-HANDOFF|UI-ARTWORK|KIRI-INSTALL-TRIAL|KIRI-FUNCTIONAL-ACCEPTANCE)[^\s/]*\.md',
        text,
    ):
        raise ValueError('Private work-log reference in ' + str(path))
    for name, pattern in [
        ('personal path', PRIVATE_PATH),
        ('private key', PRIVATE_KEY),
        ('authentication key', AUTH_KEY),
        ('agent instruction', INTERNAL_HEADING),
    ]:
        if pattern.search(text):
            raise ValueError(name + ' in ' + str(path))


def resolve_file(root, relative):
    """Reject symlinks at every path component, including existing ancestors."""
    path = safe_path(relative)
    current = root
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Symlink in publication input: ' + relative)
    if not current.is_file():
        raise ValueError('Missing publication input: ' + relative)
    return current


def inventory(root, paths):
    result = {}
    if len(paths) != len(set(paths)):
        raise ValueError('Duplicate publication entry')
    for relative in paths:
        source = resolve_file(root, relative)
        data = source.read_bytes()
        inspect_text(PurePosixPath(relative), data)
        result[relative] = {
            'sha256': hashlib.sha256(data).hexdigest(),
            'bytes': len(data),
        }
    return result


def check_references(root, paths):
    """Keep relative JavaScript imports inside the reviewed source inventory."""
    allowed = set(paths)
    for relative in paths:
        if not relative.endswith(('.js', '.mjs')):
            continue
        text = (root / relative).read_text()
        imports = re.findall(r"""(?:from\s*|import\s*)['"](\.[^'"]+)['"]""", text)
        for spec in imports:
            # File URLs in test imports and normal relative ESM imports share
            # the same resolution. No module code is executed during packaging.
            target = (root / relative).parent.joinpath(spec).resolve()
            try:
                rel = target.relative_to(root.resolve()).as_posix()
            except ValueError as exc:
                raise ValueError('Import escapes publication root') from exc
            if rel not in allowed:
                raise ValueError('Unlisted import in ' + relative + ': ' + spec)


def check_html(root, paths):
    """Require local page resources and navigation targets to be listed too."""
    allowed = set(paths)

    class Links(HTMLParser):
        def handle_starttag(self, tag, attrs):
            for name, value in attrs:
                if name in {'src', 'href'} and value:
                    links.append(value)

    for relative in paths:
        if not relative.endswith('.html'):
            continue
        links = []
        parser = Links()
        parser.feed((root / relative).read_text())
        for link in links:
            url = urlsplit(link)
            if url.scheme or url.netloc or not url.path:
                continue
            if url.path.startswith('/'):
                raise ValueError(
                    'Root-relative resource is not project-path safe: ' + relative
                )
            resource = url.path + 'index.html' if url.path.endswith('/') else url.path
            target = (root / relative).parent.joinpath(resource).resolve()
            try:
                name = target.relative_to(root.resolve()).as_posix()
            except ValueError as exc:
                raise ValueError('Page resource escapes publication root') from exc
            if name not in allowed:
                raise ValueError(
                    'Unlisted page resource in ' + relative + ': ' + url.path
                )


def candidate_files(root):
    """Package only the builder's unsigned, non-installable CI candidate."""
    base = 'web/releases/0.1.0/'
    manifest = json.loads(resolve_file(root, base + 'manifest.json').read_text())
    envelope = json.loads(resolve_file(root, base + 'manifest.signed.json').read_text())
    if (
        manifest.get('channel') != 'candidate'
        or manifest.get('profile', {}).get('bootstrapAccepted')
        or envelope != {'unsigned': True}
    ):
        raise ValueError('Only an unsigned CI candidate may use this packaging mode')
    paths = [base + 'manifest.json', base + 'manifest.signed.json']
    for entry in manifest['files']:
        relative = base + str(safe_path(entry['url']))
        data = resolve_file(root, relative).read_bytes()
        if (
            len(data) != entry['size']
            or hashlib.sha256(data).hexdigest() != entry['sha256']
        ):
            raise ValueError('Candidate asset failed integrity checks')
        paths.append(relative)
        obj = base + 'objects/' + entry['sha256']
        if resolve_file(root, obj).read_bytes() != data:
            raise ValueError('Candidate object differs from its payload')
        paths.append(obj)
    for name in ['bootstrap.tgz', 'recovery.tgz']:
        entry = manifest['updates'][name]
        if entry['url'] != name:
            raise ValueError('Unexpected root archive path')
        data = resolve_file(root, base + name).read_bytes()
        if (
            len(data) != entry['size']
            or hashlib.sha256(data).hexdigest() != entry['sha256']
        ):
            raise ValueError('Candidate root archive failed integrity checks')
        paths.append(base + name)
    return sorted(set(paths))


def export(
    root, output, kind, policy, initialise_git=False, candidate=False, preview=False
):
    """Write a new immutable snapshot; a failed copy leaves no partial output."""
    if output.exists():
        raise ValueError('Publication output already exists')
    paths = list(policy[kind])
    if preview and (kind != 'site' or candidate):
        raise ValueError(
            'Preview export must be a static site without native candidates'
        )
    if preview and any(
        x.startswith(('web/releases/', 'web/collection/')) for x in paths
    ):
        raise ValueError('Preview inventory cannot contain native packages')
    if preview:
        legacy = {
            'web/app.js',
            'web/upgrade.html',
            'web/upgrade.js',
            'web/diagnostics.html',
            'web/diagnostics.js',
        }
        paths = [path for path in paths if path not in legacy]
    if candidate:
        if kind != 'site':
            raise ValueError('Candidate packaging applies to sites only')
        paths += candidate_files(root)
    records = inventory(root, paths)
    check_references(root, paths)
    check_html(root, paths)
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        output.mkdir()
        for relative in paths:
            target = (
                PurePosixPath(relative).relative_to('web').as_posix()
                if kind == 'site'
                else relative
            )
            destination = output / target
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / relative, destination)
            # Preserve executable tools without copying filesystem metadata.
            destination.chmod(
                0o755 if (root / relative).stat().st_mode & 0o111 else 0o644
            )
            if (
                hashlib.sha256(destination.read_bytes()).hexdigest()
                != records[relative]['sha256']
            ):
                raise ValueError('Publication copy changed: ' + relative)
            if preview and relative == 'web/index.html':
                text = destination.read_text()
                if text.count('<head>') != 1:
                    raise ValueError('Preview page must contain one head element')
                text = text.replace(
                    '<head>',
                    '<head>\n  <meta name="kobold-site-mode" content="preview">',
                    1,
                )
                destination.write_text(text)
                payload = destination.read_bytes()
                records[relative] = {
                    'sha256': hashlib.sha256(payload).hexdigest(),
                    'bytes': len(payload),
                }
        (output / 'PUBLICATION.json').write_text(
            json.dumps(
                {
                    'schema': 1,
                    'kind': kind,
                    'preview': preview,
                    'files': {
                        PurePosixPath(k).relative_to('web').as_posix()
                        if kind == 'site'
                        else k: v
                        for k, v in records.items()
                    },
                },
                indent=2,
            )
            + '\n'
        )
        if initialise_git:
            if kind != 'source':
                raise ValueError('Git initialisation applies to source snapshots only')
            subprocess.run(
                ['git', 'init', '--initial-branch=main', str(output)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ['git', '-C', str(output), 'add', '.'], check=True, capture_output=True
            )
            subprocess.run(
                [
                    'git',
                    '-C',
                    str(output),
                    'commit',
                    '-m',
                    'Initial public source snapshot',
                ],
                check=True,
                capture_output=True,
            )
    except BaseException:
        shutil.rmtree(output)
        raise
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--kind', choices=['source', 'site'], default='source')
    parser.add_argument('--initialise-git', action='store_true')
    parser.add_argument('--candidate-release', action='store_true')
    parser.add_argument('--preview', action='store_true')
    args = parser.parse_args()
    policy = json.loads(POLICY.read_text())
    records = export(
        args.root.resolve(),
        args.output.resolve(),
        args.kind,
        policy,
        args.initialise_git,
        args.candidate_release,
        args.preview,
    )
    print(
        json.dumps(
            {'kind': args.kind, 'files': len(records), 'output': str(args.output)}
        )
    )


if __name__ == '__main__':
    main()
