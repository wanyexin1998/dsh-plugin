import { readFileSync, writeFileSync } from 'node:fs'
const p = 'src/client/components/SqlEditor.tsx'
let t = readFileSync(p, 'utf8')

t = t.replace(`import { tokenizeSql } from '../highlight.ts'`,
`import { tokenizeSql } from '../highlight.ts'
import { caretLine, lineCount, matchBrackets } from '../editor.ts'`)

t = t.replace(`  const [placement, setPlacement] = React.useState<{ readonly top: number; readonly left: number }>({ top: 0, left: 0 })`,
`  const [placement, setPlacement] = React.useState<{ readonly top: number; readonly left: number }>({ top: 0, left: 0 })
  const [caret, setCaret] = React.useState(0)
  const [lineHeight, setLineHeight] = React.useState(21)
  const gutter = React.useRef<HTMLDivElement | null>(null)
  const currentLineRef = React.useRef<HTMLDivElement | null>(null)`)

t = t.replace(`  /** Keep the colouring layer aligned with the textarea's scroll offset. */
  const syncScroll = (element: HTMLTextAreaElement): void => {
    const layer = overlay.current
    /* v8 ignore next -- the overlay renders beside the textarea */
    if (layer === null) return
    layer.scrollTop = element.scrollTop
    layer.scrollLeft = element.scrollLeft
  }`,
`  /** Keep the colouring layer aligned with the textarea's scroll offset. */
  const syncScroll = (element: HTMLTextAreaElement): void => {
    const layer = overlay.current
    /* v8 ignore next -- the overlay renders beside the textarea */
    if (layer === null) return
    layer.scrollTop = element.scrollTop
    layer.scrollLeft = element.scrollLeft
    // The gutter and the current-line band live outside the scrolling layer.
    if (gutter.current !== null) gutter.current.style.transform = \`translateY(-\${element.scrollTop}px)\`
    if (currentLineRef.current !== null) {
      currentLineRef.current.style.transform = \`translateY(-\${element.scrollTop}px)\`
    }
  }

  // Measure the real line height once: font metrics come from the host theme.
  React.useEffect(() => {
    const element = textarea.current
    /* v8 ignore next -- the ref exists for the life of the mounted editor */
    if (element === null) return
    const measured = Number.parseFloat(window.getComputedStyle(element).lineHeight)
    if (Number.isFinite(measured) && measured > 0) setLineHeight(measured)
  }, [])

  const lines = lineCount(sql)
  const activeLine = caretLine(sql, caret)
  const brackets = matchBrackets(sql, caret)

  /** Split a token so the matched brackets can be marked, keeping the rest intact. */
  const renderToken = (text: string, kind: string, offset: number, key: string): React.ReactNode => {
    const className = kind === 'plain' ? undefined : styles[\`tok\${kind.charAt(0).toUpperCase()}\${kind.slice(1)}\`]
    if (brackets === undefined) return <span key={key} className={className}>{text}</span>

    const marks = [brackets.open, brackets.close].filter(at => at >= offset && at < offset + text.length)
    if (marks.length === 0) return <span key={key} className={className}>{text}</span>

    const nodes: React.ReactNode[] = []
    let cursor = offset
    for (const at of marks.sort((left, right) => left - right)) {
      const before = text.slice(cursor - offset, at - offset)
      if (before !== '') nodes.push(<span key={\`\${key}:\${cursor}\`} className={className}>{before}</span>)
      nodes.push(<span key={\`\${key}:mark:/${at}/`} className={styles.bracketMark}>{text[at - offset]}</span>)
      cursor = at + 1
    }
    const tail = text.slice(cursor - offset)
    if (tail !== '') nodes.push(<span key={\`\${key}:\${cursor}:tail\`} className={className}>{tail}</span>)
    return <React.Fragment key={key}>{nodes}</React.Fragment>
  }`)

t = t.replace(`        <pre className={styles.highlight} ref={overlay} aria-hidden="true" data-sql-highlight="">
          {tokenizeSql(sql).map((token, index) => (
            <span
              key={\`\${index}:\${token.kind}\`}
              className={token.kind === 'plain' ? undefined : styles[\`tok\${token.kind.charAt(0).toUpperCase()}\${token.kind.slice(1)}\`]}
            >
              {token.text}
            </span>
          ))}
          {'\\n'}
        </pre>`,
`        <div className={styles.gutter} aria-hidden="true" data-sql-gutter="">
          <div ref={gutter}>
            {Array.from({ length: lines }, (_unused, index) => (
              <div key={index} className={index + 1 === activeLine ? styles.gutterActive : styles.gutterLine}>
                {index + 1}
              </div>
            ))}
          </div>
        </div>
        <div
          className={styles.currentLine}
          aria-hidden="true"
          data-sql-current-line=""
          ref={currentLineRef}
          style={{ top: \`\${8 + (activeLine - 1) * lineHeight}px\`, height: \`\${lineHeight}px\` }}
        />
        <pre className={styles.highlight} ref={overlay} aria-hidden="true" data-sql-highlight="">
          {(() => {
            let offset = 0
            return tokenizeSql(sql).map((token, index) => {
              const node = renderToken(token.text, token.kind, offset, \`\${index}:\${token.kind}\`)
              offset += token.text.length
              return node
            })
          })()}
          {'\\n'}
        </pre>`)

t = t.replace(`          onChange={event => {
            onChange(event.target.value)
            refresh(event.target.value, event.target.selectionStart as number)
          }}`,
`          onChange={event => {
            setCaret(event.target.selectionStart as number)
            onChange(event.target.value)
            refresh(event.target.value, event.target.selectionStart as number)
          }}
          onSelect={event => {
            setCaret(event.currentTarget.selectionStart)
          }}
          onClick={event => {
            setCaret(event.currentTarget.selectionStart)
          }}`)

writeFileSync(p, t)
console.log('editor updated')
