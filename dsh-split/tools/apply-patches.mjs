#!/usr/bin/env node
/**
 * Reproducible patch generator (M-A1 delivery).
 *
 * Rebuilds `patches/patched/**` from the untouched `patches/originals/**` every run:
 *
 *   1. verify every original against `patches/originals/MANIFEST.json` (SHA-256);
 *   2. apply the minimal, anchored edits listed below — a missing anchor aborts;
 *   3. parse-check each patched file with esbuild;
 *   4. write `patches/patched/MANIFEST.json` and a human-readable `patches/PATCHES.md`.
 *
 * While the element `<html>` has
 * `data-dsh-plugin-main-host`, a plugin owns the main content host — so the right
 * column stays usable and session navigation must not reset the panel selection.
 * Per-session sidebar hosts and their change event hold the corresponding views.
 * Attachment routing uses each native composer's anchor and its conversation DOM.
 *
 * Usage: node tools/apply-patches.mjs [--check] [--output dist/host-patches-fix]
 * Generation and parsing happen in memory before any output is changed.
 * --output stages a release without touching the installed junction targets.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sidebarRetentionEdits } from './patches/sidebar-retention.mjs'
import { attachmentRoutingEdits } from './patches/attachment-routing.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const originals = join(repo, 'patches', 'originals')
const patched = join(repo, 'patches', 'patched')
const checkOnly = process.argv.includes('--check')
const outputArg = process.argv.indexOf('--output')
if (outputArg !== -1 && (!process.argv[outputArg + 1] || process.argv[outputArg + 1].startsWith('--'))) {
  throw new Error('--output requires a directory')
}
const outputRoot = outputArg === -1 ? patched : resolve(repo, process.argv[outputArg + 1])
const stagingRelative = relative(join(repo, 'dist'), outputRoot)
if (outputRoot !== patched && (!stagingRelative || stagingRelative.startsWith('..') || isAbsolute(stagingRelative))) {
  throw new Error('--output must be a child directory of this workspace\'s dist/')
}

const MARKER = 'data-dsh-plugin-main-host'
const guard = `!document.documentElement.hasAttribute("${MARKER}")`

/** Line-indexed edits: [package, file, 0-based line, replacement text]. */
const LINE_EDITS = [
  {
    id: 'P-1a',
    pkg: 'dsh-client-ui-workspace',
    file: 'lib/client.js',
    line: 968,
    why: 'clearMain() 不再把面板选择强拉回会话界面（插件占用 main 键位时）',
    replace: (original) => leadingTabs(original) + `if (${guard}) this.ctx.layout.selectPanel(null);`,
  },
  {
    id: 'P-1b',
    pkg: 'dsh-client-ui-workspace',
    file: 'lib/client.js',
    line: 992,
    why: 'reveal 导航不再把面板选择强拉回会话界面',
    replace: (original) => leadingTabs(original) + `if (panel === "reveal" && ${guard}) this.ctx.layout.selectPanel(null);`,
  },
]

/** Text-anchored edits: [package, file, find, replacement, id, why]. */
const TEXT_EDITS = [
  {
    id: 'P-1c',
    pkg: 'dsh-client-ui-sidebar-right',
    file: 'lib/client.js',
    find: 'const visible = usePanelInfo((info) => info.activePanelId === null);',
    replace: `const visible = usePanelInfo((info) => info.activePanelId === null || document.documentElement.hasAttribute("${MARKER}"));`,
    why: '插件占用主内容宿主期间右栏保持可见（原判定只看 activePanelId === null）',
  },
  {
    id: 'P-1d',
    pkg: 'dsh-client-ui-sidebar-right',
    file: 'lib/client.js',
    find: 'show(layout.panelInfo.getSnapshot().activePanelId === null ? selected?.sessionId : void 0);',
    replace: `show(layout.panelInfo.getSnapshot().activePanelId === null || document.documentElement.hasAttribute("${MARKER}") ? selected?.sessionId : void 0);`,
    why: '侧栏控制器的 show() 用同一判定，否则轨道被释放',
  },
  {
    id: 'P-3a',
    pkg: 'dsh-client-ui-attachment',
    file: 'lib/client.js',
    find: '\t\t\tconst onDragEnter = (event) => {\n',
    replace: '\t\t\tconst onDragEnter = (event) => {\n\t\t\t\tif (event.defaultPrevented) return;\n',
    why: '尊重捕获阶段的 veto（插件拦截本次拖放）',
  },
  {
    id: 'P-3b',
    pkg: 'dsh-client-ui-attachment',
    file: 'lib/client.js',
    find: '\t\t\tconst onDragOver = (event) => {\n',
    replace: '\t\t\tconst onDragOver = (event) => {\n\t\t\t\tif (event.defaultPrevented) return;\n',
    why: '同上：不显示"可放下"覆盖层',
  },
  {
    id: 'P-3c',
    pkg: 'dsh-client-ui-attachment',
    file: 'lib/client.js',
    find: '\t\t\tconst onDrop = (event) => {\n',
    replace: '\t\t\tconst onDrop = (event) => {\n\t\t\t\tif (event.defaultPrevented) return;\n',
    why: '本次放下已由插件定向到一个会话，原生 intake 不再处理',
  },
  {
    id: 'P-2a',
    pkg: 'dsh-client-ui-sidebar-right',
    file: 'lib/client.js',
    find: '\t\tfunction SessionView({ view, visible, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }) {',
    replace: '\t\tfunction SessionView({ view, visible, hosted, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }) {',
    why: 'SessionView 接受 hosted：宿主内呈现的会话侧栏不受"只显示前台"判定约束',
  },
  {
    id: 'P-2b',
    pkg: 'dsh-client-ui-sidebar-right',
    file: 'lib/client.js',
    find: '\t\t\tconst active = visible && view.selected;',
    replace: '\t\t\tconst active = hosted === true ? true : visible && view.selected;',
    why: 'hosted 时按会话自身是否在屏判定 active（每格一块侧栏同时可见）',
  },
  {
    id: 'P-2c',
    pkg: 'dsh-client-ui-sidebar-right',
    file: 'lib/client.js',
    find: '\t\t\treturn (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: useViews((value) => value).map((view) => (0, react_jsx_runtime.jsx)(SessionView, {\n\t\t\t\t...props,\n\t\t\t\tview,\n\t\t\t\tvisible\n\t\t\t}, view.sessionId)) });',
    replace: [
      '\t\t\tconst [hostVersion, setHostVersion] = react.useState(0);',
      '\t\t\treact.useEffect(() => {',
      '\t\t\t\tconst onChange = () => setHostVersion((value) => value + 1);',
      '\t\t\t\tconst onResize = () => setHostVersion((value) => value + 1);',
      '\t\t\t\tdocument.addEventListener("dsh-sidebar-host-change", onChange);',
      '\t\t\t\twindow.addEventListener("resize", onResize);',
      '\t\t\t\treturn () => { document.removeEventListener("dsh-sidebar-host-change", onChange); window.removeEventListener("resize", onResize); };',
      '\t\t\t}, []);',
      '\t\t\treturn (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: useViews((value) => value).map((view) => {',
      '\t\t\t\tvoid hostVersion;',
      '\t\t\t\tconst host = document.querySelector(\'[data-dsh-sidebar-host="\' + CSS.escape(view.sessionId) + \'"]\');',
      '\t\t\t\tconst hostWidth = host === null ? 0 : Math.max(0, host.clientWidth);',
      '\t\t\t\tconst face = (0, react_jsx_runtime.jsx)(SessionView, {',
      '\t\t\t\t\t...props,',
      '\t\t\t\t\tview,',
      '\t\t\t\t\tvisible,',
      '\t\t\t\t\thosted: host !== null,',
      '\t\t\t\t\twidth: host === null || hostWidth === 0 ? props.width : hostWidth,',
      '\t\t\t\t\tviewportWidth: props.viewportWidth,',
      '\t\t\t\t\tcanShow: host === null ? props.canShow : true',
      '\t\t\t\t}, view.sessionId);',
      '\t\t\t\treturn host === null ? face : (0, react_dom.createPortal)(face, host);',
      '\t\t\t}) });',
    ].join('\n'),
    why: '每会话侧栏 portal 进 [data-dsh-sidebar-host="<sessionId>"]（CSS.escape 防注入），按宿主实测宽度下发 width（0 宽回退轨道宽度），viewportWidth 保持应用视口以保住 autoFullscreen 启发式；响应 dsh-sidebar-host-change 与窗口 resize',
  },
  {
    id: 'P-2d',
    pkg: 'dsh-client-ui-sidebar-right',
    file: 'lib/client.js',
    find: '\t\t\tconst toggle = shortcuts.find((entry) => entry.id === "sidebar.right.toggle");\n\t\t\treturn (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
    replace: '\t\t\tconst toggle = shortcuts.find((entry) => entry.id === "sidebar.right.toggle");\n\t\t\tconst splitView = typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-plugin-main-host");\n\t\t\treturn splitView ? null : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
    why: 'F07/V02：分屏视图下 PanelChrome 整体不渲染（返回 null 于组件级，绝不把 null 传进 Tooltip 子节点）',
  },
  {
    id: 'P-2g',
    pkg: 'dsh-client-ui-sidebar-right',
    file: 'lib/client.js',
    find: '\t\t\tconst shown = active && surface !== void 0 && surface.layout.expanded;',
    replace: '\t\t\tconst shown = active && surface !== void 0 && surface.layout.expanded && !(typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-plugin-main-host"));',
    why: 'W014/P-2「内容与 frame 呈现分离」：分屏期间 frame 右栏轨道不再打开（内容已 portal 进各会话宿主），回到单窗口时原生行为原样恢复',
  },
  {
    id: 'P-2h',
    pkg: 'dsh-client-ui-sidebar-right',
    file: 'lib/client.js',
    find: '\t\t\t\t"data-sidebar-right-open": expanded || void 0,\n\t\t\t\t"aria-hidden": !expanded || void 0,',
    replace: '\t\t\t\t"data-sidebar-right-open": expanded || typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-plugin-main-host") || void 0,\n\t\t\t\t"aria-hidden": (!expanded && !(typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-plugin-main-host"))) || void 0,',
    why: 'F07：宿主内呈现时侧栏内容的显隐由插件拥有（data-dsh-sidebar-collapsed），不再被原生 expanded 状态滑出屏幕',
  },
  ...sidebarRetentionEdits,
  ...attachmentRoutingEdits,
]

function leadingTabs(line) {
  const match = /^[\t ]*/.exec(line)
  return match === null ? '' : match[0]
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/* ------------------------------------------------------------------- run it -- */

const manifestPath = join(originals, 'MANIFEST.json')
if (!existsSync(manifestPath)) {
  console.error('missing ' + manifestPath + ' — stage the originals first')
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

let failures = 0
for (const entry of manifest.files) {
  const file = join(originals, entry.pkg, entry.file)
  if (!existsSync(file)) {
    console.error('MISSING original: ' + entry.pkg + '/' + entry.file)
    failures += 1
    continue
  }
  const hash = sha256(readFileSync(file))
  if (hash !== entry.sha256) {
    console.error('HASH MISMATCH original: ' + entry.pkg + '/' + entry.file)
    failures += 1
  }
}
if (failures > 0) {
  console.error('refusing to patch: ' + failures + ' original file(s) do not match the manifest')
  process.exit(2)
}
console.log('originals verified against the manifest (' + manifest.files.length + ' files)')

// Keep the installed tree untouched until all anchors and JavaScript pass validation.
const generated = new Map(manifest.files.map((entry) => [
  join(entry.pkg, entry.file), readFileSync(join(originals, entry.pkg, entry.file)),
]))

const applied = []
let aborted = 0

for (const edit of LINE_EDITS) {
  const file = join(edit.pkg, edit.file)
  const lines = generated.get(file).toString('utf8').split('\n')
  const original = lines[edit.line]
  if (original === undefined || original.indexOf('selectPanel') === -1) {
    console.error('ANCHOR MISS ' + edit.id + ': ' + edit.pkg + '/' + edit.file + ' line ' + (edit.line + 1))
    aborted += 1
    continue
  }
  lines[edit.line] = edit.replace(original)
  generated.set(file, Buffer.from(lines.join('\n')))
  applied.push({ ...edit, from: original, to: lines[edit.line] })
}

for (const edit of TEXT_EDITS) {
  const file = join(edit.pkg, edit.file)
  const text = generated.get(file).toString('utf8')
  const occurrences = text.split(edit.find).length - 1
  if (occurrences !== 1) {
    console.error('ANCHOR MISS ' + edit.id + ': ' + edit.pkg + '/' + edit.file + ' (' + occurrences + ' matches, need 1)')
    aborted += 1
    continue
  }
  generated.set(file, Buffer.from(text.replace(edit.find, () => edit.replace)))
  applied.push({ ...edit, from: edit.find, to: edit.replace })
}

if (aborted > 0) {
  console.error('aborted: ' + aborted + ' edit(s) could not be anchored')
  process.exit(2)
}

/* syntax-check every patched JavaScript file with esbuild's parser */
const { transform } = await import('esbuild')
let parseFailures = 0
for (const [file, bytes] of generated) {
  if (!file.endsWith('.js')) continue
  const code = bytes.toString('utf8')
  try {
    await transform(code, { loader: 'js', format: 'esm' })
  } catch (error) {
    console.error('PARSE FAIL ' + file + ': ' + String(error.message ?? error))
    parseFailures += 1
  }
}
if (parseFailures > 0) {
  console.error('aborted: ' + parseFailures + ' patched file(s) do not parse')
  process.exit(2)
}
console.log('patched files parse cleanly (' + applied.length + ' edits applied)')

if (checkOnly) {
  /* byte-compare the regenerated tree against the committed one */
  const committed = manifest.files.map((entry) => ({ ...entry, rel: join(entry.pkg, entry.file) }))
  let drift = 0
  for (const entry of committed) {
    const regenerated = generated.get(entry.rel)
    const onDisk = existsSync(join(outputRoot, entry.rel)) ? readFileSync(join(outputRoot, entry.rel)) : null
    if (onDisk === null || !regenerated.equals(onDisk)) {
      console.error('DRIFT ' + entry.rel + ' — ' + outputRoot + ' differs from a fresh generation')
      drift += 1
    }
  }
  console.log('--check: ' + (drift === 0 ? 'committed patched tree matches a fresh generation (' + committed.length + ' files)' : drift + ' file(s) drifted'))
  process.exit(drift === 0 ? 0 : 2)
}

const patchedManifest = {
  generatedAt: new Date().toISOString(),
  baseManifest: 'patches/originals/MANIFEST.json',
  markerContract: MARKER,
  edits: applied.map((edit) => ({ id: edit.id, pkg: edit.pkg, file: edit.file, why: edit.why })),
  files: manifest.files.map((entry) => {
    const bytes = generated.get(join(entry.pkg, entry.file))
    return { pkg: entry.pkg, file: entry.file, originalSha256: entry.sha256, patchedSha256: sha256(bytes), bytes: bytes.length }
  }),
}
for (const [file, bytes] of generated) {
  mkdirSync(dirname(join(outputRoot, file)), { recursive: true })
  writeFileSync(join(outputRoot, file), bytes)
}
writeFileSync(join(outputRoot, 'MANIFEST.json'), JSON.stringify(patchedManifest, null, 2))

const lines = [
  '# 补丁记录（M-A1：原件 + 最小差异）',
  '',
  '**生成方式**：`node tools/apply-patches.mjs`（每次从 `patches/originals/**` 重建，原件哈希先校验、锚点缺失即中止、产物用 esbuild 解析校验）。',
  '**标记契约**：`' + MARKER + '` 标识分屏宿主；`data-dsh-sidebar-host` 与 `dsh-sidebar-host-change` 管理侧栏持有；附件按 `data-conversation-session` 和独立 Composer 锚点路由，缺省回退限定在 `data-dsh-split-session` 正文内。',
  '',
  '## 已应用',
  '',
  '| # | 包 | 文件 | 改动 |',
  '| --- | --- | --- | --- |',
]
for (const edit of applied) {
  lines.push('| ' + edit.id + ' | `' + edit.pkg + '` | `' + edit.file + '` | ' + edit.why + ' |')
}
lines.push('', '## 逐条差异', '')
for (const edit of applied) {
  const renderDiff = (text) => String(text).split('\n').map((line) => (line === '' ? '' : line)).join('\n')
  const fromLines = String(edit.from).split('\n')
  const toLines = String(edit.to).split('\n')
  lines.push('### ' + edit.id + ' — ' + edit.why, '', '```diff')
  for (const line of fromLines) lines.push('- ' + line)
  for (const line of toLines) lines.push('+ ' + line)
  lines.push('```', '')
}
lines.push('## 回退', '', '回退本轮修复时同时恢复安装前的 `lib/` 与宿主补丁备份，具体路径见 `docs/local-install-20261016.md`。`app.asar` 与 `patches/originals` 保持原样。', '')
const reportPath = outputRoot === patched ? join(repo, 'patches', 'PATCHES.md') : join(outputRoot, 'PATCHES.md')
writeFileSync(reportPath, lines.join('\n'))

console.log('wrote ' + join(outputRoot, 'MANIFEST.json') + ' and ' + reportPath)
for (const edit of applied) console.log('  ' + edit.id + '  ' + edit.pkg)
