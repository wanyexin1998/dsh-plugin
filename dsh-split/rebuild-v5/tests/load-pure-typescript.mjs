import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// The distributable is CommonJS, while these isolated pure modules export ESM.
// Node 24's own TypeScript stripper avoids compiling or reading legacy source.
export async function loadPureTypeScript(url) {
  const source = await readFile(url, 'utf8');
  const code = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url.href });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
