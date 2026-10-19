import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Fresh, read-only ASAR reader. Never loads code from the archive. */
export function openAsar(filename) {
  const absolute = path.resolve(filename);
  const fd = fs.openSync(absolute, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4) throw new Error('Invalid ASAR size pickle');
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    const stat = fs.fstatSync(fd);
    if (headerSize < 8 || jsonSize > headerSize - 8 || headerSize > 64 * 1024 * 1024 || 8 + headerSize > stat.size) throw new Error('Invalid ASAR header bounds');
    const json = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, json, 0, jsonSize, 16) !== jsonSize) throw new Error('Truncated ASAR header');
    const header = JSON.parse(json.toString('utf8'));
    const dataOffset = 8 + headerSize;
    const entries = new Map();
    const walk = (files, prefix = '') => {
      for (const [name, entry] of Object.entries(files || {})) {
        if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('Unsafe ASAR member');
        const member = prefix ? `${prefix}/${name}` : name;
        if (entry.files) walk(entry.files, member);
        else entries.set(member, entry);
      }
    };
    walk(header.files);
    const read = member => {
      const entry = entries.get(member);
      if (!entry) throw new Error(`Missing ASAR member: ${member}`);
      if (entry.link) throw new Error(`ASAR link is not followed: ${member}`);
      if (entry.unpacked) throw new Error(`Unpacked member is outside this reader: ${member}`);
      const offset = Number(entry.offset), size = entry.size;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || dataOffset + offset + size > stat.size) throw new Error(`Invalid ASAR bounds: ${member}`);
      const buffer = Buffer.alloc(size);
      const memberFd = fs.openSync(absolute, 'r');
      try { if (fs.readSync(memberFd, buffer, 0, size, dataOffset + offset) !== size) throw new Error(`Truncated member: ${member}`); }
      finally { fs.closeSync(memberFd); }
      return buffer;
    };
    return { filename: absolute, header, entries, dataOffset, read, text: member => read(member).toString('utf8') };
  } finally { fs.closeSync(fd); }
}

export function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

/**
 * Resolve the shipped web-frontend entry bundle by shape, not by hashed filename.
 * The asset hash changes every DSH release, so tests must never hardcode it.
 * Picks the largest top-level (non /langs/) script under dist/assets.
 */
export function findFrontendBundle(archive) {
  const prefix = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/';
  let best = null;
  for (const [member, entry] of archive.entries) {
    if (!member.startsWith(prefix)) continue;
    const rest = member.slice(prefix.length);
    if (rest.includes('/')) continue;
    if (!rest.endsWith('.js')) continue;
    const size = entry.size ?? 0;
    if (!best || size > best.size) best = { member, size };
  }
  if (!best) throw new Error('Missing web-frontend entry bundle under dist/assets');
  return best.member;
}

/**
 * Build an evaluable expression that yields the shipped slot module
 * ({SlotCore, SlotOwnershipError, StaleAuthorizationError, standardHookPropName}).
 *
 * Asset hashes and minified identifiers both change every DSH release, so this
 * resolves the export map by its stable public keys (`SlotCore:` etc.) and then
 * slices the enclosing declaration region instead of hardcoding names like
 * `function ah(e)`.
 */
export function readSlotsModuleSource(archive) {
  return readExportedModuleSource(archive, 'SlotCore');
}

/**
 * Build an evaluable expression yielding the module whose export map contains
 * `anchorKey` (e.g. 'SlotCore', 'DockLayout'). All exported bindings are
 * returned so callers can pick the members they need.
 *
 * Both the asset filename and the minified identifiers change every DSH
 * release. Only the public export keys are stable, so they are the anchors.
 */
export function readExportedModuleSource(archive, anchorKey) {
  const bundle = archive.text(findFrontendBundle(archive));
  const at = bundle.indexOf(`${anchorKey}:`);
  if (at < 0) throw new Error(`Missing ${anchorKey} export in web-frontend bundle`);
  const mapKey = bundle.lastIndexOf('__proto__:null,', at);
  if (mapKey < 0) throw new Error(`Missing export map for ${anchorKey}`);
  const braceStart = bundle.lastIndexOf('{', mapKey);
  if (braceStart < 0) throw new Error(`Missing export map brace for ${anchorKey}`);
  let depth = 0, braceEnd = -1;
  for (let i = braceStart; i < bundle.length; i++) {
    const c = bundle[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { braceEnd = i + 1; break; }
  }
  if (braceEnd < 0) throw new Error(`Unterminated export map for ${anchorKey}`);
  const map = bundle.slice(braceStart, braceEnd);
  const pairs = [...map.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g)]
    .map(([, key, ident]) => [key, ident])
    .filter(([key]) => key !== '__proto__');
  if (!pairs.length) throw new Error(`Export map for ${anchorKey} has no entries`);
  // 声明一定在导出 map 之前；注意新版 bundle 在 map 语句前可能没有分号，
  // 所以不能用 lastIndexOf(';') 作为声明搜索的上界。
  let start = Infinity;
  for (const [, ident] of pairs) {
    const esc = ident.replace(/\$/g, '\\$');
    const re = new RegExp(`(?:class\\s+|function\\s+|(?:const|let|var)\\s+|[;,]\\s*)${esc}\\s*[=(]`);
    const m = bundle.slice(0, braceStart).match(re);
    if (!m) throw new Error(`${anchorKey} export identifier has no declaration: ${ident}`);
    start = Math.min(start, m.index);
  }
  const stmtStart = bundle.lastIndexOf(';', start) + 1;
  // body 截止于导出 map 所在语句的开头，避免把 defineProperty( 半截切进来
  const head = bundle.slice(Math.max(0, braceStart - 200), braceStart);
  const mapHead = head.match(/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*Object\.freeze\(Object\.defineProperty\($/);
  const bodyEnd = mapHead ? braceStart - mapHead[0].length : bundle.lastIndexOf(';', braceStart) + 1;
  const body = bundle.slice(stmtStart, bodyEnd);
  const literal = pairs.map(([key, ident]) => `${key}:${ident}`).join(',');
  return `${body};({${literal}})`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , filename, command = 'list', argument = ''] = process.argv;
  if (!filename) throw new Error('Usage: node read-asar.mjs <archive> [list|read|find|hash] [member-or-pattern]');
  const archive = openAsar(filename);
  if (command === 'list') {
    for (const [member, entry] of archive.entries) if (!argument || member.includes(argument)) console.log(`${entry.size ?? 0}\t${member}`);
  } else if (command === 'read') process.stdout.write(archive.read(argument));
  else if (command === 'hash') console.log(argument ? sha256(archive.read(argument)) : sha256(fs.readFileSync(filename)));
  else if (command === 'find') {
    for (const [member, entry] of archive.entries) {
      if (entry.unpacked || entry.link || !/\.(?:js|mjs|json|css|html)$/.test(member) || entry.size > 20 * 1024 * 1024) continue;
      const source = archive.text(member);
      let at = source.indexOf(argument), count = 0;
      while (at >= 0 && count++ < 12) { console.log(`${member}:${at}: ${source.slice(Math.max(0, at - 160), at + argument.length + 220).replace(/\n/g, '\\n')}`); at = source.indexOf(argument, at + argument.length); }
    }
  } else throw new Error(`Unknown command: ${command}`);
}
