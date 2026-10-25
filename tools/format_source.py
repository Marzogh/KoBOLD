#!/usr/bin/env python3
"""Apply the pinned source formatters without touching generated releases/assets."""

import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    tracked = (
        subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT)
        .decode()
        .split('\0')
    )
    javascript = [p for p in tracked if p.endswith(('.js', '.mjs'))]
    python = [
        p for p in tracked if p.endswith('.py') and p.startswith(('tools/', 'tests/'))
    ]
    # npm downloads only the exact formatter version; it is not a runtime input.
    subprocess.run(
        [
            'npx',
            '--yes',
            'prettier@3.6.2',
            '--check' if args.check else '--write',
            *javascript,
        ],
        cwd=ROOT,
        check=True,
    )
    if (
        subprocess.check_output(['ruff', '--version'], text=True).strip()
        != 'ruff 0.15.15'
    ):
        raise RuntimeError('Use Ruff 0.15.15 for reproducible formatting')
    subprocess.run(
        ['ruff', 'format', *(['--check'] if args.check else []), *python],
        cwd=ROOT,
        check=True,
    )


if __name__ == '__main__':
    main()
