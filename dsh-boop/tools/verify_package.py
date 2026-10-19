#!/usr/bin/env python3
"""Read-only BOOP document package verification. Python 3.9+; no network."""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def main() -> int:
    root = Path(__file__).resolve().parents[1]
    errors = []
    count = 0
    try:
        lines = (root / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines()
        for line in lines:
            if not line.strip():
                continue
            expected, name = line.split('  ', 1)
            path = (root / name).resolve()
            if not path.is_relative_to(root) or Path(name).is_absolute():
                errors.append(f'Unsafe entry: {name}')
                continue
            if not path.is_file():
                errors.append(f'Missing: {name}')
                continue
            if digest(path) != expected:
                errors.append(f'Changed: {name}')
            count += 1
        frozen = json.loads((root / 'manifests/FROZEN_BASELINE.json').read_text(encoding='utf-8'))
        base = root / frozen['preservedDirectory']
        for item in frozen['preservedFiles']:
            p = (base / item['path']).resolve()
            if not p.is_relative_to(base.resolve()) or not p.is_file() or digest(p) != item['sha256']:
                errors.append(f'Frozen baseline mismatch: {item["path"]}')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append(str(exc))
    if errors:
        print('FAIL: package differs from the delivery manifest.')
        for error in errors:
            print(' -', error)
        return 1
    print(f'PASS: {count} packaged files verified; frozen design baseline is unchanged.')
    print('This is a document-integrity check, NOT a BOOP plugin/runtime test or a digital signature.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
