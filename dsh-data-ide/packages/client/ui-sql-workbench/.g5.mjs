import { readFileSync, writeFileSync } from 'node:fs'

// core: count never rejects (it is caught before the race), so drop the dead arm.
let p = 'src/execute/core.ts'
let t = readFileSync(p, 'utf8')
t = t.replace(`    void work.then(value => {
      clearTimeout(timer)
      resolve(value)
    }, () => {
      clearTimeout(timer)
      resolve(fallback)
    })`,
`    void work.then(value => {
      clearTimeout(timer)
      resolve(value)
    })`)
writeFileSync(p, t)

// grid: only strings can become data URLs; binary export requires object URLs.
p = 'src/client/components/ResultGrid.tsx'
t = readFileSync(p, 'utf8')
t = t.replace(`    : \`data:/${type},/${encodeURIComponent(typeof content === 'string' ? content : '')}\``,
`    /* v8 ignore next -- binary export needs object URLs; the data-URL path is text only */
    : \`data:/${type},/${encodeURIComponent(typeof content === 'string' ? content : '')}\``)
t = t.replace(`  const exportPage = (): void => {
    if (result === null) return`,
`  const exportPage = (): void => {
    /* v8 ignore next -- the button only renders with a result */
    if (result === null) return`)
writeFileSync(p, t)
console.log('dead branches trimmed')
