#!/usr/bin/env python3
import os
import subprocess
import tempfile
from build import go_toolchain
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
go = go_toolchain()
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
