import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractLinuxBinary } from '../lib/host/bootstrap.js';
import { platformTarget } from '../lib/adapters/local/executable.js';

const block = Buffer.alloc(512, 0);
function header(name, size, { type = '0', mode = 0o755, linkname = '' } = {}) {
  const out = Buffer.alloc(512, 0);
  out.write(name, 0, 100, 'utf8');
  out.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'latin1');
  out.write('0000000\0', 108, 8, 'latin1');
  out.write('0000000\0', 116, 8, 'latin1');
  out.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
  out.write('00000000000\0', 136, 12, 'latin1');
  out.write('        ', 148, 8, 'latin1');
  out.write(type, 156, 1, 'latin1');
  out.write(linkname, 157, 100, 'utf8');
  out.write('ustar\0', 257, 6, 'latin1');
  out.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const byte of out) sum += byte;
  out.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return out;
}
function tar(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    parts.push(header(entry.name, data.length, entry));
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  parts.push(block, block);
  return Buffer.concat(parts);
}
const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(200)]);
const archive = entries => gzipSync(tar(entries));
const release = (binary = elf) => archive([
  { name: './', type: '5', mode: 0o755, data: '' },
  { name: './LICENSE', data: 'license' },
  { name: './README.md', data: 'readme' },
  { name: './dws', data: binary },
]);

test('tar.gz extractor returns exactly one plain dws binary and ignores release docs', () => {
  assert.deepEqual(extractLinuxBinary(release()), elf);
  assert.deepEqual(extractLinuxBinary(archive([{ name: 'dws', data: elf, mode: 0o755 }])), elf);
  assert.deepEqual(extractLinuxBinary(archive([{ name: 'nested/dws', data: elf }])), elf, 'single top-level directory is tolerated');
});
test('tar.gz extractor rejects duplicate, missing, linked, traversing and corrupt members', () => {
  assert.throws(() => extractLinuxBinary(archive([{ name: 'LICENSE', data: 'x' }])), { reasonCode: 'cli_integrity_failed' });
  assert.throws(() => extractLinuxBinary(archive([{ name: 'dws', data: elf }, { name: 'dws', data: elf }])), { reasonCode: 'cli_integrity_failed' });
  assert.throws(() => extractLinuxBinary(archive([{ name: 'dws', type: '2', data: '', linkname: '/bin/sh' }])), { reasonCode: 'cli_integrity_failed' });
  assert.throws(() => extractLinuxBinary(archive([{ name: '../dws', data: elf }])), { reasonCode: 'cli_integrity_failed' });
  assert.throws(() => extractLinuxBinary(archive([{ name: '/dws', data: elf }])), { reasonCode: 'cli_integrity_failed' });
  assert.throws(() => extractLinuxBinary(archive([{ name: 'a/b/dws', data: elf }])), { reasonCode: 'cli_integrity_failed' }, 'multi-level paths are not an expected release layout');
  const corrupt = Buffer.from(release()); corrupt[corrupt.length - 20] ^= 0xff;
  assert.throws(() => extractLinuxBinary(corrupt), { reasonCode: 'cli_integrity_failed' });
  assert.throws(() => extractLinuxBinary(Buffer.from('not gzip')), { reasonCode: 'cli_integrity_failed' });
  assert.throws(() => extractLinuxBinary(Buffer.alloc(0)), { reasonCode: 'cli_integrity_failed' });
});
test('platform pins cover win32 x64 and linux amd64 only; ELF validation is exact', () => {
  assert.equal(platformTarget('win32', 'x64').key, 'win32-x64');
  assert.equal(platformTarget('linux', 'x64').key, 'linux-x64');
  for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'x64'], ['win32', 'arm64'], ['freebsd', 'x64']]) assert.equal(platformTarget(platform, arch), undefined);
  assert.deepEqual([{ key: 'linux-x64', machine: 0x3e }], [{ key: platformTarget('linux', 'x64').key, machine: platformTarget('linux', 'x64').machine }]);
});

const cache = resolve('../.cache/dws-artifact/dws-linux-amd64.tar.gz');
const locks = JSON.parse(await readFile(new URL('../dws.lock.json', import.meta.url), 'utf8'));
const skip = !existsSync(cache);
test('pinned linux-amd64 release artifact extracts to the pinned binary hash', { skip }, async () => {
  const bytes = await readFile(cache);
  const locked = locks.dws.assets.find(asset => asset.platform === 'linux-amd64');
  assert.equal(bytes.length, locked.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), locked.sha256);
  const binary = extractLinuxBinary(bytes);
  assert.equal(binary.length, 58091152);
  assert.equal(binary.toString('hex', 0, 4), '7f454c46');
  assert.equal(binary[4], 2); assert.equal(binary[5], 1);
  assert.equal(binary.readUInt16LE(18), 0x3e);
  assert.equal(createHash('sha256').update(binary).digest('hex'), locks.dws.binaryChecksums['linux-x64']);
});
