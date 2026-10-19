/**
 * Report identifiers a module declares but never uses again.
 *
 * A declaration whose name appears exactly once in the file is dead: nothing
 * reads it. This walks top-level and nested declarations by indentation-aware
 * regex, so it works on the hand-written modules here without a parser.
 *
 * Usage: node tools/find-dead-code.mjs <file> [<file> ...]
 */

import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node tools/find-dead-code.mjs <file> [<file> ...]')
  process.exit(2)
}

/** Declarations to check: const/let/var bindings and named functions. */
const DECLARATIONS = [
  /^[ \t]*function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
  /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
  /^[ \t]*const\s*\{([^}]+)\}\s*=/gm,
]

let dead = 0
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  // Strip comments so a name mentioned only in prose does not count as a use.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  // Per file: a name declared in one module says nothing about the same name in
  // another, and a shared count would report every repeated identifier as dead.
  const names = new Map()
  for (const pattern of DECLARATIONS) {
    for (const match of code.matchAll(pattern)) {
      // The destructuring pattern captures the whole brace list, so it is always a
      // binding list — even for one binding, with or without an alias. Checking for
      // a comma would miss `const { createElement: h } = React` entirely.
      if (pattern.source.includes('\\{')) {
        for (const part of match[1].split(',')) {
          const name = part.trim().split(':').pop().trim()
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.set(name, (names.get(name) ?? 0) + 1)
        }
      } else {
        names.set(match[1], (names.get(match[1]) ?? 0) + 1)
      }
    }
  }
  const unused = []
  for (const [name, declared] of names) {
    const uses = (code.match(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')) ?? []).length
    if (uses <= declared) unused.push({ name, declared, uses })
  }
  console.log('--- ' + file + ' (' + String(names.size) + ' declarations)')
  if (unused.length === 0) console.log('    no unused declarations')
  for (const entry of unused) {
    console.log('    UNUSED  ' + entry.name + '  (declared ' + String(entry.declared) + ', mentions ' + String(entry.uses) + ')')
    dead += 1
  }
}
console.log('')
console.log(String(dead) + ' unused declaration(s)')
process.exit(dead === 0 ? 0 : 1)
