#!/usr/bin/env python3
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
go = os.environ.get('KOBOLD_GO') or str(ROOT / 'cache/toolchain/go/bin/go')
if not Path(go).is_file():
    go = shutil.which('go') or go
subprocess.run(
    [go, 'test', './...'],
    cwd=ROOT / 'device/provenance',
    env={
        **os.environ,
        'GOTOOLCHAIN': 'local',
        'GOCACHE': os.environ.get(
            'GOCACHE', str(Path(tempfile.gettempdir()) / 'kobold-go-build-cache')
        ),
    },
    check=True,
)
