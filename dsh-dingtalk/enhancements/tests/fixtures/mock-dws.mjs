// A real subprocess fixture with synthetic identities only. Never bundled in the plugin.
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const control = JSON.parse(readFileSync(process.env.MOCK_DWS_CONTROL, 'utf8'));
const stage = args.includes('--version') ? 'version' : args.slice(0, args[0] === 'doc' ? 2 : 3).join(' ');
appendFileSync(control.trace, JSON.stringify({ stage, args, pid: process.pid }) + '\n');
if (stage === 'version') {
  console.log(control.oldVersion ? 'dws version v0.0.1 (old, test)' : 'dws version v1.0.66 (f215043e676d6889e1ddce3464828d8b1ec40c31, test)');
} else if (stage === 'auth status --readonly') {
  console.log(JSON.stringify(control.inconclusive ? { success: true, authenticated: false, reason: 'local_state_unreadable' } : control.unlinked ? { success: true, authenticated: false } : {
    success: true, authenticated: true, token_valid: !control.expired, refresh_token_valid: true,
    corp_id: 'test-corp', user_id: 'test-user',
  }));
} else if (stage === 'contact user get-self') {
  console.log(JSON.stringify({ success: true, result: control.employees ?? [{ orgEmployeeModel: { corpId: 'test-corp', userId: control.wrongIdentity ? 'wrong-user' : 'test-user' } }] }));
} else if (stage === 'aitable base create' && control.receipt) {
  console.log(JSON.stringify(control.receipt));
} else if (control.stream) {
  const bytes = Buffer.from(JSON.stringify({ success: true, text: '合成中文事件', access_token: 'test-private-access' }) + '\n');
  // Split inside a UTF-8 character, exercising streaming decoder state.
  const at = bytes.indexOf(Buffer.from('中')) + 1;
  process.stdout.write(bytes.subarray(0, at));
  setTimeout(() => { process.stdout.write(bytes.subarray(at)); if (!control.hang) process.exit(0); }, 15);
  if (control.hang) setInterval(() => {}, 1000);
} else if (control.flatDocuments && stage === 'doc search') {
  console.log(JSON.stringify({ success: true, documents: control.badDocuments ? null : control.emptyDocuments ? [] : [{ name: '合成中文文档', nodeId: 'synthetic-node' }], hasMore: false, nextPageToken: '' }));
} else if (control.pat) {
  process.stderr.write(JSON.stringify({ success: false, code: control.pat, data: { uri: 'https://untrusted.invalid/never-follow' } }));
  process.exitCode = 4;
} else if (control.hang || control.spawnChild) {
  if (control.spawnChild) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    writeFileSync(control.childPid, String(child.pid));
  }
  setInterval(() => {}, 1000);
} else if (control.large) {
  (control.large === 'stderr' ? process.stderr : process.stdout).write('x'.repeat(10000));
} else if (control.badJson) console.log('{not-json');
else if (control.error) {
  process.stderr.write(JSON.stringify({ error: { category: 'auth', code: 2, message: 'authCode=test-private-code refresh_token=test-private-refresh /private/path' } }));
  process.exitCode = 2;
} else {
  if (control.delay) await new Promise(resolve => setTimeout(resolve, control.delay));
  console.log(JSON.stringify({ success: true, result: { items: [{ title: '测试结果', access_token: 'test-private-access', text: 'Authorization: Bearer test-private-bearer authCode=test-private-code' }], nextCursor: 'test-cursor' } }));
}
