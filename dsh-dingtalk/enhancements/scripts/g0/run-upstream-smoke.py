"""Run the pinned upstream fixture with Windows registry isolation; no real OAuth."""
import argparse
import hashlib
import json
import os
import contextlib
import io
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, help='Pinned upstream test-auth-exchange-local.py')
parser.add_argument('--binary', required=True, help='Verified official DWS binary')
parser.add_argument('--out', required=True, help='Sanitized JSON evidence destination')
args = parser.parse_args()
plugin = Path(__file__).resolve().parents[2]
lock = json.loads((plugin / 'dws.lock.json').read_text(encoding='utf-8'))
binary = Path(args.binary).resolve()
platform = 'win32-x64' if os.name == 'nt' and os.environ.get('PROCESSOR_ARCHITECTURE', '').lower() == 'amd64' else None
if not platform or hashlib.sha256(binary.read_bytes()).hexdigest() != lock['dws']['binaryChecksums'].get(platform):
    raise SystemExit('Unverified OS/binary; refusing execution')
source = Path(args.source).read_text(encoding='utf-8')  # Universal newline normalization.
expected = lock['dws']['upstreamSmoke']['sourceSha256LF']
if hashlib.sha256(source.encode()).hexdigest() != expected:
    raise SystemExit('Upstream smoke source checksum mismatch')

# Upstream strips all DWS_* variables and does not set the Windows test namespace.
# Add only process isolation and disable update checks. Preserve every assertion.
needle = '                return env, directory'
if source.count(needle) != 1:
    raise SystemExit('Upstream fixture shape changed; review required')
replacement = '''                env["DWS_KEYCHAIN_TEST_NAMESPACE"] = str(directory)
                env["DWS_NO_UPDATE_CHECK"] = "1"
                test_namespaces.append(str(directory))
                return env, directory'''
source = source.replace(needle, replacement)
test_namespaces = []
import sys
sys.argv = [args.source, '--binary', str(binary)]
try:
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        exec(compile(source, args.source, 'exec'), {'__name__': '__main__', 'test_namespaces': test_namespaces})
    report = json.loads(captured.getvalue())
    report['adaptation'] = lock['dws']['upstreamSmoke']['adaptation']
    report['classification'] = 'LOCAL_FIXTURE_ONLY'
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'success': True, 'checkGroups': len(report['checks']), 'classification': report['classification']}))
finally:
    if os.name == 'nt':
        import winreg
        for namespace in test_namespaces:
            digest = hashlib.sha256(os.path.abspath(namespace).lower().encode()).hexdigest()[:32]
            path = 'Software\\DwsCli\\keychain\\dws-cli\\test-' + digest
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_ALL_ACCESS) as key:
                    while winreg.QueryInfoKey(key)[1]:
                        winreg.DeleteValue(key, winreg.EnumValue(key, 0)[0])
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
            except FileNotFoundError:
                pass
