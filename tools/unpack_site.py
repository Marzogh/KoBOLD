#!/usr/bin/env python3
"""Extract a checksum-identified site ZIP without traversal or symlink entries."""

import argparse
import hashlib
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath


def unpack(archive, output, checksum):
    if (
        not re.fullmatch('[a-f0-9]{64}', checksum)
        or hashlib.sha256(archive.read_bytes()).hexdigest() != checksum
    ):
        raise ValueError('Site archive SHA256 mismatch')
    if output.exists():
        raise ValueError('Output exists')
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        names = [m.filename for m in entries]
        if (
            len(names) != len(set(names))
            or len(names) > 2000
            or sum(m.file_size for m in entries) > 512 * 1024 * 1024
        ):
            raise ValueError('Invalid archive inventory or size')
        for m in entries:
            n = m.filename.rstrip('/')
            if (
                not n
                or '\\' in n
                or n.startswith('/')
                or any(x in ('', '.', '..') for x in n.split('/'))
                or (m.external_attr >> 16) & 0o170000 == 0o120000
            ):
                raise ValueError('Unsafe archive entry')
            PurePosixPath(n)
        try:
            output.mkdir(parents=True)
            z.extractall(output)
        except BaseException:
            shutil.rmtree(output)
            raise


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('archive', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('sha256')
    a = p.parse_args()
    unpack(a.archive, a.output, a.sha256)
