import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256} from './read-asar.mjs';

/** Patch only the browser half. The host half keeps its shipped dependency scope. */
export function stageNativePackage(archive, packageName, client, destination) {
  const prefix = `dsh/node_modules/${packageName}/`;
  const metadata = JSON.parse(archive.text(`${prefix}package.json`));
  const originalHost = archive.text(`${prefix}lib/index.js`);
  // Re-exporting from the installed ASAR resolves schemastery, protocol and their
  // transitive imports beside the native module instead of the external release.
  const hostUrl = pathToFileURL(path.join(archive.filename, prefix, 'lib/index.js')).href;
  const host = `// Host implementation stays in the SHA-256-pinned DSH installation.\nexport * from ${JSON.stringify(hostUrl)};\n`;
  if (/export\s+(?:default\b|\{[^}]*\bas\s+default\b)/.test(originalHost)) {
    throw new Error(`Native host default export needs explicit forwarding: ${packageName}`);
  }
  fs.mkdirSync(path.join(destination, 'lib'), {recursive: true});
  const files = new Map([
    ['package.json', JSON.stringify(metadata, null, 2) + '\n'],
    ['lib/index.js', host],
    ['lib/client.js', client],
  ]);
  for (const filename of ['LICENSE', 'README.md', 'README.zh.md']) {
    if (archive.entries.has(prefix + filename)) files.set(filename, archive.read(prefix + filename));
  }
  for (const [name, value] of files) fs.writeFileSync(path.join(destination, name), value);
  return {hostUrl, originalHostSha256: sha256(originalHost), files: [...files].map(([name, value]) => ({name, sha256: sha256(value)}))};
}

export function verifyPackageFiles(item) {
  if (!Array.isArray(item.files) || item.files.length === 0) throw new Error(`Missing package integrity: ${item.name}`);
  for (const file of item.files) {
    const absolute = path.resolve(item.target, file.name);
    if (!absolute.startsWith(path.resolve(item.target) + path.sep)) throw new Error('Package file escapes release');
    if (sha256(fs.readFileSync(absolute)) !== file.sha256) throw new Error(`Hash mismatch: ${item.name}/${file.name}`);
  }
}
