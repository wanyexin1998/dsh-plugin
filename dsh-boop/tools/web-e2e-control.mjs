#!/usr/bin/env node
/**
 * Real-browser human-control interaction test for the BOOP panel.
 *
 * Drives the installed Microsoft Edge (playwright-core; no browser download)
 * against a real DSH 0.2.1-rc.2 web Host booted in a private `$DSH_HOME`
 * under `.work/test-runs/`. It never touches the user's `~/.dsh` and never
 * edits the gate ledger or STATUS.md. Write mode follows that ledger. The
 * control clicks still must not dispatch.
 *
 * Usage:
 *   node tools/web-e2e-control.mjs [--edge-channel msedge] [--out <dir>] [--keep]
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright-core'
import {
  PROJECT_ROOT,
  bootWeb,
  createProfile,
  freePort,
  hostFacts,
  makeHome,
} from '../tests/helpers/test-host.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const EDGE_CHANNEL = flag('--edge-channel', 'msedge')
const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/web-e2e-control-' + Date.now())
const HOME = makeHome(path.join(WORK, 'dsh-home'))
const PROFILE = 'boop-web-e2e-control'
const OUT = path.resolve(flag('--out', path.join(PROJECT_ROOT, 'docs/development/evidence/web-e2e-control')), stamp)
const SHOTS = path.join(OUT, 'screens')
const BASE_URL = process.env.BOOP_QWEN_BASE_URL ?? 'http://172.26.0.49:8000/v1'
const MODEL_ID = process.env.BOOP_QWEN_MODEL ?? 'qwen3.8-27b'
const EXPECTED_DSH = '0.2.1-rc.2'
const COMPOSED = '波波'

/** Copy from `src/client/control.tsx` / `control-model.ts`. Assertions match these strings. */
const COPY = {
  stopWarning: '请求已发送 ≠ 外部副作用已撤销',
  noop: '没有可停止内容',
  noopMarker: 'noop=true',
  notUndone: '不是“已撤销成功”',
  hostNothing: '没有可停止的 BOOP 动作',
  stopFailed: '没有把它显示成已停止',
  ledgerUntouched: '没有改动任何动作',
  stoppedBucket: '已停止（BOOP 尚未投递',
  recoveryExplicit: '必须逐项',
  recoveryKeepBlocked: '未勾选的旧 BOOP 命令保持阻断',
  recoveryEmptySelection: '没有默认选中任何条目',
  releaseRefused: '没有把它显示成已释放',
  releaseInvalid: '必须显式选择要释放的 messageId',
  emptyApproval: '服务端确认：当前没有等待你决定的有效审批（不是读取失败）。',
  decisionRecorded: '服务端已记录：允许本次（仅落账）',
  blockedApproval: '当前没有可直接决定的审批',
  readFailed: '没有把失败当作',
  unavailable: '不可用不等于',
}

const PLANNED = [
  'private web profile prepared (write mode follows the gate ledger)',
  'web Host booted on 127.0.0.1',
  'Edge shell ready',
  'BOOP task board opened',
  'deterministic Stop is honest',
  'recovery has no select-all and empty release is refused',
  'approval empty state is honest',
  'seeded approval is recorded and not dispatched',
  'stale approval cannot be decided',
  'IME composition on a BOOP text field',
]

const steps = []
const shots = []
const consoleNotes = []
const samples = {}
let blocker = null

function clip(value, max = 360) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function record(name, status, detail) {
  const row = { name, status, detail: detail == null || detail === '' ? null : clip(detail, 900) }
  steps.push(row)
  console.log(`${status} ${name}${row.detail ? ` — ${row.detail}` : ''}`)
  return row
}

function fillNotRun(reason) {
  const done = new Set(steps.map((step) => step.name))
  for (const name of PLANNED) {
    if (!done.has(name)) record(name, 'NOT_RUN', reason)
  }
}

function verdictOf() {
  if (steps.some((step) => step.status === 'FAIL')) return 'FAIL'
  if (steps.some((step) => step.status === 'NOT_RUN') || steps.length === 0) return 'NOT_RUN'
  return 'PASS'
}

function assertPrivateHome(home) {
  const resolved = path.resolve(home)
  const root = path.resolve(PROJECT_ROOT)
  const userHome = process.env.USERPROFILE || process.env.HOME || ''
  const userDsh = userHome ? path.resolve(userHome, '.dsh') : ''
  const norm = (value) => value.replaceAll('\\', '/').toLowerCase()
  if (!norm(resolved).startsWith(`${norm(root)}/`)) {
    throw new Error(`DSH_HOME must stay under the project work directory: ${resolved}`)
  }
  if (!norm(resolved).includes('/.work/test-runs/')) {
    throw new Error(`DSH_HOME must stay under .work/test-runs: ${resolved}`)
  }
  if (userDsh && (norm(resolved) === norm(userDsh) || norm(resolved).startsWith(`${norm(userDsh)}/`))) {
    throw new Error(`refusing to touch the user DSH home: ${resolved}`)
  }
}

function rel(target) {
  return path.relative(PROJECT_ROOT, target).replaceAll('\\', '/')
}

async function screenshot(page, name) {
  const target = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: target, fullPage: false })
  const relative = rel(target)
  shots.push(relative)
  return relative
}

const visibleMaskCount = (page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('div[aria-hidden="true"]')].filter(
        (element) => /mask/iu.test(element.className?.toString() ?? '') && element.getBoundingClientRect().width > 0,
      ).length,
  )

async function dialogDiagnostics(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="presentation"]')]
      .filter((root) => (root.textContent ?? '').trim().length > 0)
      .map((root) => ({
        text: (root.textContent ?? '').trim().slice(0, 200),
        buttons: [...root.querySelectorAll('button')].map((button) => ({
          text: (button.textContent ?? '').trim().slice(0, 20),
          aria: button.getAttribute('aria-label'),
          disabled: button.disabled === true,
        })),
      })),
  )
}

/**
 * Dismiss every first-run dialog currently blocking clicks.
 * The preview notice (`预览版说明`) disables 继续 while its acknowledgement
 * write is in flight, and some shells leave that attribute set until the
 * modal finishes mounting. Wait for an enabled button, then activate it once.
 */
async function closeBlockingDialogs(page) {
  let forced = false
  for (let round = 0; round < 30; round += 1) {
    if ((await visibleMaskCount(page)) === 0) return 0
    await page.waitForTimeout(400)
    const primary = page.locator('[role="presentation"] button:visible', { hasText: /^(继续|知道了|跳过|我已知晓|开始使用)$/ }).first()
    if ((await primary.count()) > 0) {
      const enabled = await primary.isEnabled().catch(() => false)
      if (enabled) {
        console.log(`dialog round ${round}: clicking enabled primary`)
        await primary.click({ timeout: 4000 }).catch((error) => console.log(`dialog click failed: ${clip(error, 180)}`))
        await page.waitForTimeout(1000)
        continue
      }
      if (!forced && round >= 2) {
        forced = true
        const outcome = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll('[role="presentation"] button')]
          const target = buttons.find((button) =>
            /^(继续|知道了|跳过|我已知晓|开始使用)$/u.test((button.textContent ?? '').trim()),
          )
          if (!(target instanceof HTMLButtonElement)) return 'no-button'
          target.disabled = false
          target.click()
          return `forced disabled=${target.disabled}`
        })
        console.log(`dialog round ${round}: ${outcome}`)
        await page.waitForTimeout(1500)
        continue
      }
      console.log(`dialog round ${round}: primary still disabled`)
      continue
    }
    const closed = await page.evaluate(() => {
      const roots = [...document.querySelectorAll('[role="presentation"]')]
      for (const root of roots) {
        const buttons = [...root.querySelectorAll('button')]
        const close = buttons.find((button) =>
          /关闭|close|跳过|取消/iu.test(`${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`),
        )
        if (close instanceof HTMLElement && !close.disabled) {
          close.click()
          return true
        }
      }
      return false
    })
    if (closed) continue
    await page.keyboard.press('Escape').catch(() => {})
  }
  return visibleMaskCount(page)
}

/** Click a real UI element, clearing any dialog that appears in front of it. */
async function guardedClick(page, locator, label) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const masks = await closeBlockingDialogs(page)
    try {
      await locator.first().click({ timeout: 6000 })
      return
    } catch {
      if (attempt === 3) {
        const diagnostics = await dialogDiagnostics(page)
        throw new Error(`${label} click blocked (masks=${masks}): ${JSON.stringify(diagnostics).slice(0, 900)}`)
      }
      await page.waitForTimeout(500)
    }
  }
}

async function prepareProfile() {
  await createProfile(HOME, PROFILE, { dependencies: { 'dsh-boop': `link:${PROJECT_ROOT}` } })
  const manifestPath = path.join(HOME, 'profiles', PROFILE, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles = [...new Set([...(manifest.dsh.profile.bundles ?? []), 'dsh-boop'])]
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  // Isolated profile only. Write mode is not switched on; the patch only
  // declares a local model route so the shell can leave first-run onboarding.
  fs.writeFileSync(
    path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'),
    `# Web UI control E2E profile patch (isolated DSH_HOME only; never a user profile).
# Write mode is intentionally not enabled.
- id: llm-pi-ai
  config:
    providers:
      qwen-local:
        displayName: Qwen local (vLLM)
        api: openai-completions
        baseURL: ${BASE_URL}
        apiKeyEnv: BOOP_QWEN_KEY
        models:
          - id: ${MODEL_ID}
            name: Qwen 3.8 27B (self-hosted vLLM)
            contextWindow: 196608
- id: agent-default-model
  config:
    provider: qwen-local
    model: ${MODEL_ID}
- id: ui-settings-models
  config:
    credentialOnboarding: false
`,
    'utf8',
  )
}

function parseActionCounts(text) {
  if (!text) return { total: null, pending: null, accepted: null, unknown: null, blocked: null, cancelled: null }
  const pick = (label) => {
    const match = text.match(new RegExp(`${label}\\s*(\\d+)`, 'u'))
    return match ? Number(match[1]) : null
  }
  return {
    total: pick('动作'),
    pending: pick('待发'),
    accepted: pick('已投递'),
    unknown: pick('未知'),
    blocked: pick('阻塞'),
    cancelled: pick('已取消'),
  }
}

function assessStop({ sectionText, resultText, noop, accepted, counts }) {
  const warning = sectionText.includes(COPY.stopWarning)
  const stoppedBucket = resultText.includes(COPY.stoppedBucket)
  const claimsUndo = /外部副作用已撤销\s*=\s*是/u.test(resultText)
  const claimsUserTurn = /用户 turn 被停\s*=\s*是/u.test(resultText)
  const noopHonest =
    noop === 'true' &&
    resultText.includes(COPY.noop) &&
    resultText.includes(COPY.noopMarker) &&
    resultText.includes(COPY.notUndone)
  const hostNothing = resultText.includes(COPY.hostNothing)
  const refusedHonest =
    (resultText.includes(COPY.stopFailed) || resultText.includes(COPY.ledgerUntouched)) && !stoppedBucket
  const emptyPlane = counts.total === 0 && counts.pending === 0 && counts.accepted === 0
  const quoted = clip(resultText, 420)

  if (claimsUndo || claimsUserTurn) {
    return { ok: false, detail: `stop result claims an external undo or a stopped user turn. ${quoted}` }
  }
  if (!warning) {
    return { ok: false, detail: `missing the permanent warning (${COPY.stopWarning}). ${quoted}` }
  }
  if (stoppedBucket && (emptyPlane || counts.total === null)) {
    return {
      ok: false,
      detail: `page lists stopped items although no running BOOP action was on the board (counts=${JSON.stringify(counts)}). ${quoted}`,
    }
  }
  if (noop === 'true' && noopHonest && !stoppedBucket) {
    return { ok: true, detail: `noop; nothing was claimed stopped. ${quoted}` }
  }
  if (accepted === 'false' && refusedHonest) {
    return { ok: true, detail: `host refused the stop and the page did not claim a running task was stopped. ${quoted}` }
  }
  if ((emptyPlane || counts.total === null) && hostNothing && !stoppedBucket) {
    return { ok: true, detail: `host reported nothing to stop. ${quoted}` }
  }
  if (!emptyPlane && counts.total !== null && warning && !claimsUndo) {
    return {
      ok: true,
      detail: `host had actions (counts=${JSON.stringify(counts)}); the result keeps 请求已发送 distinct from 已撤销. ${quoted}`,
    }
  }
  return {
    ok: false,
    detail: `stop result is not an honest noop or refusal. noop=${noop} accepted=${accepted} counts=${JSON.stringify(counts)} ${quoted}`,
  }
}

function assessRecovery({ controls, checkedCount, release, resultText, sectionText }) {
  const selectAll = controls.filter((control) => {
    const ownText = control.tag === 'BUTTON' ? control.text : ''
    return /全选|select-all|select all/iu.test(`${control.action ?? ''} ${control.aria ?? ''} ${ownText}`)
  })
  const releasedMatch = resultText.match(/已释放\s+(\d+)/u)
  const releasedCount = releasedMatch ? Number(releasedMatch[1]) : 0
  const bulkSuccess =
    releasedCount > 0 ||
    /已全部释放|批量放行|released everything/iu.test(`${resultText}\n${sectionText}`)
  const refusalCopy = [
    COPY.recoveryExplicit,
    COPY.recoveryKeepBlocked,
    COPY.recoveryEmptySelection,
    COPY.releaseRefused,
    COPY.releaseInvalid,
    'INVALID_ARGUMENT',
    'INVALID',
  ].some((needle) => `${sectionText}\n${resultText}`.includes(needle))
  const emptyButton = /释放选中（0）/u.test(release?.text ?? '')
  const detail = [
    `selectAll=${selectAll.length}`,
    `checked=${checkedCount}`,
    `release=${JSON.stringify(release)}`,
    `receipt=${resultText ? clip(resultText, 240) : 'none'}`,
    `section=${clip(sectionText, 220)}`,
  ].join(' ')

  if (selectAll.length > 0) return { ok: false, detail: `select-all control is present. ${detail}` }
  if (checkedCount > 0) return { ok: false, detail: `recovery had a default selection; the empty-submit case was not run. ${detail}` }
  if (bulkSuccess) return { ok: false, detail: `empty selection produced a release success. ${detail}` }
  if (!release) return { ok: false, detail: `recovery UI has no release button. ${detail}` }
  if (refusalCopy && (emptyButton || /INVALID|必须显式选择|没有把它显示成已释放/u.test(resultText))) {
    return { ok: true, detail }
  }
  if (refusalCopy && emptyButton && !resultText) {
    return {
      ok: true,
      detail: `empty selection stayed refused: the release control shows 释放选中（0） and did not render a success receipt. ${detail}`,
    }
  }
  return { ok: false, detail: `empty release did not show a refusal. ${detail}` }
}

function assessApprovals({ state, controlText, approvalsText, cards }) {
  const pendingMatch = approvalsText.match(/待决\s+(\d+)/u)
  const pending = pendingMatch ? Number(pendingMatch[1]) : null
  const honestEmpty = approvalsText.includes(COPY.emptyApproval)
  const honestBlocked = approvalsText.includes(COPY.blockedApproval)
  const readFailed = controlText.includes(COPY.readFailed) || controlText.includes(COPY.unavailable)
  const fakeZero = approvalsText.includes('服务端确认：当前没有等待你决定的有效审批')
  const decidablePending = cards.filter((card) => card.status === 'pending' && card.canDecide === 'true')
  const quoted = clip(approvalsText, 320)

  if (state === 'error' || state === 'unavailable') {
    return {
      ok: readFailed && !fakeZero && decidablePending.length === 0,
      detail: `control ${state}; a failed read is not reported as zero pending. ${clip(controlText, 280)}`,
    }
  }
  if (state !== 'ready') return { ok: false, detail: `control state is ${state}. ${quoted}` }
  if (decidablePending.length > 0 && (pending === 0 || pending === null)) {
    return { ok: false, detail: `zero/unknown pending but ${decidablePending.length} decidable approval card(s) are visible. ${quoted}` }
  }
  if (pending === 0 || ((honestEmpty || honestBlocked) && decidablePending.length === 0 && (pending === null || pending === 0))) {
    if (!honestEmpty && !honestBlocked) return { ok: false, detail: `pending is ${pending} without the honest empty sentence. ${quoted}` }
    return {
      ok: true,
      detail: `pending=${pending ?? 'unparsed'} cards=${cards.length} decidablePending=${decidablePending.length}. ${honestEmpty ? COPY.emptyApproval : COPY.blockedApproval}`,
    }
  }
  if (pending !== null && pending > 0) {
    if (decidablePending.length > pending) {
      return { ok: false, detail: `visible decidable cards ${decidablePending.length} exceed 待决 ${pending}` }
    }
    return {
      ok: true,
      detail: `host reports 待决 ${pending}; visible decidable cards=${decidablePending.length}; no approval was submitted by this test. ${quoted}`,
    }
  }
  return { ok: false, detail: `approval section is not an honest empty or counted state. ${quoted}` }
}

async function openWorkspace(page) {
  const workspaceSelector = page.locator('[aria-label="选择工作区"]')
  if ((await workspaceSelector.count()) > 0 && /选择一个工作区开始/u.test(await page.locator('body').innerText())) {
    await guardedClick(page, workspaceSelector, 'workspace selector')
    await page.waitForTimeout(600)
    const menuItem = page.getByRole('menuitem', { name: /默认工作区/ })
    if ((await menuItem.count()) > 0) await guardedClick(page, menuItem, 'workspace menu item')
    else await guardedClick(page, page.getByText('默认工作区', { exact: true }).last(), 'workspace text')
    await page.waitForTimeout(1000)
  }
}

async function openBoard(page) {
  const boardEntry = page.locator('[aria-label="BOOP 任务板"]')
  if ((await boardEntry.count()) < 1) {
    return { ok: false, detail: 'BOOP 任务板 entry is not registered', writeModeOn: false, dispatchClosed: false }
  }
  await guardedClick(page, boardEntry, 'BOOP board entry')
  await page.waitForSelector('[data-boop-panel]', { timeout: 20_000 })
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[data-boop-panel]')
      const control = document.querySelector('[data-boop-control]')
      const state = control?.getAttribute('data-boop-control-state')
      return Boolean(panel?.innerText.includes('写模式') && control && state && state !== 'loading')
    },
    null,
    { timeout: 40_000 },
  )
  await page.locator('[data-boop-control]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  const panelShot = await screenshot(page, '02-board-control')
  const writeLine = (await page.locator('[data-boop-control-write-mode]').innerText().catch(() => '')).replace(/\s+/gu, ' ')
  const panelText = await page.locator('[data-boop-panel]').innerText()
  const controlState = await page.locator('[data-boop-control]').getAttribute('data-boop-control-state')
  const writeModeOn = /写模式：\s*开启/u.test(writeLine)
  const heroOn = /写模式开启/u.test(panelText)
  const dispatchClosed = /派发：\s*不可用/u.test(writeLine) && /dispatch-not-on-this-row/u.test(writeLine)
  samples.board = { controlState, writeLine: clip(writeLine, 300), shot: panelShot, writeModeOn, heroOn, dispatchClosed }
  const ok = writeModeOn && heroOn && dispatchClosed && (await page.locator('[data-boop-stop]').count()) > 0 && (await page.locator('[data-boop-recovery]').count()) > 0
  return {
    ok,
    writeModeOn,
    dispatchClosed,
    detail: `state=${controlState} writeModeOn=${writeModeOn} heroOn=${heroOn} dispatchClosed=${dispatchClosed} ${clip(writeLine, 220)}`,
  }
}

async function runStop(page) {
  const stopRoot = page.locator('[data-boop-stop]')
  await stopRoot.scrollIntoViewIfNeeded()
  const allRadio = stopRoot.locator('input[type="radio"][value="all"]')
  if ((await allRadio.count()) < 1) throw new Error('stop scope "all" radio is not in [data-boop-stop]')
  await allRadio.check({ force: true })
  const countsText = await page.locator('[data-boop-action-counts]').innerText().catch(() => '')
  const counts = parseActionCounts(countsText)
  const button = stopRoot.locator('[data-boop-stop-action="stop"]')
  const buttonText = ((await button.innerText().catch(() => '')) || '').trim()
  if (await button.isDisabled()) {
    return { status: 'FAIL', detail: `stop button is disabled before the click (${buttonText}); scope all should be sendable` }
  }
  await screenshot(page, '03-stop-before')
  await guardedClick(page, button, 'deterministic stop')
  await page.waitForSelector('[data-boop-stop-result]', { timeout: 45_000 })
  await page.waitForFunction(
    () => (document.querySelector('[data-boop-stop-result]')?.innerText ?? '').trim().length > 8,
    null,
    { timeout: 15_000 },
  )
  await page.locator('[data-boop-stop-result]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await screenshot(page, '04-stop-result')
  const result = page.locator('[data-boop-stop-result]')
  const resultText = await result.innerText()
  const sectionText = await stopRoot.innerText()
  const noop = await result.getAttribute('data-noop')
  const accepted = await result.getAttribute('data-accepted')
  samples.stop = { buttonText, countsText: clip(countsText, 200), counts, noop, accepted, resultText: clip(resultText, 700) }
  const assessed = assessStop({ sectionText, resultText, noop, accepted, counts })
  return { status: assessed.ok ? 'PASS' : 'FAIL', detail: `clicked "${buttonText}". ${assessed.detail}` }
}

async function runRecovery(page) {
  const recovery = page.locator('[data-boop-recovery]')
  await recovery.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  const before = await recovery.evaluate((root) => {
    const controls = [...root.querySelectorAll('button, input, select, [role="button"], [role="checkbox"]')].map((node) => ({
      tag: node.tagName,
      type: node.getAttribute('type'),
      action: node.getAttribute('data-boop-recovery-action'),
      aria: node.getAttribute('aria-label'),
      text: (node.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 80),
      checked: node instanceof HTMLInputElement ? node.checked === true : false,
      disabled: 'disabled' in node ? node.disabled === true : false,
    }))
    const releaseNode = root.querySelector('[data-boop-recovery-action="release"]')
    const release = releaseNode
      ? {
          text: (releaseNode.textContent ?? '').replace(/\s+/gu, ' ').trim(),
          disabled: releaseNode instanceof HTMLButtonElement ? releaseNode.disabled === true : false,
        }
      : null
    const checkedCount = [...root.querySelectorAll('input[type="checkbox"]')].filter((node) => node.checked === true).length
    return { controls, release, checkedCount }
  })
  await screenshot(page, '05-recovery')
  if (before.checkedCount > 0) {
    samples.recovery = { ...before, submitted: false }
    return {
      status: 'FAIL',
      detail: `recovery already had ${before.checkedCount} checked message id(s); refusing to submit a non-empty selection`,
    }
  }
  let forced = 'not-attempted'
  if (before.release) {
    const release = recovery.locator('[data-boop-recovery-action="release"]')
    if (before.release.disabled) {
      forced = await release
        .click({ force: true, timeout: 3000 })
        .then(() => 'playwright-force-click')
        .catch((error) => `playwright-force-click-failed: ${clip(error, 160)}`)
      const domClick = await page.evaluate(() => {
        const button = document.querySelector('[data-boop-recovery-action="release"]')
        const checked = [...document.querySelectorAll('[data-boop-recovery] input[type="checkbox"]')].filter((node) => node.checked).length
        if (!(button instanceof HTMLButtonElement) || checked !== 0) return 'skipped'
        button.disabled = false
        button.click()
        return 'dom-click-with-disabled-cleared'
      })
      forced = `${forced}; ${domClick}`
    } else {
      await guardedClick(page, release, 'release with zero selection')
      forced = 'enabled-click'
    }
  }
  await page.waitForTimeout(700)
  const busy = await page.locator('[data-boop-recovery-action="release"]').innerText().catch(() => '')
  if (/正在释放/u.test(busy)) {
    await page.waitForSelector('[data-boop-release-result]', { timeout: 20_000 }).catch(() => {})
  }
  const resultText = await page.locator('[data-boop-release-result]').innerText().catch(() => '')
  const sectionText = await recovery.innerText()
  await recovery.scrollIntoViewIfNeeded()
  await screenshot(page, '06-recovery-after-empty-release')
  samples.recovery = { ...before, forced, resultText: clip(resultText, 500), sectionText: clip(sectionText, 500) }
  const assessed = assessRecovery({ ...before, resultText, sectionText })
  return { status: assessed.ok ? 'PASS' : 'FAIL', detail: assessed.detail }
}

async function runApprovals(page) {
  const approvals = page.locator('[data-boop-approvals]')
  await approvals.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await screenshot(page, '07-approvals')
  const state = await page.locator('[data-boop-control]').getAttribute('data-boop-control-state')
  const controlText = await page.locator('[data-boop-control]').innerText()
  const approvalsText = await approvals.innerText()
  const cards = await page.locator('[data-boop-approval]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute('data-approval-id'),
      status: node.getAttribute('data-status'),
      canDecide: node.getAttribute('data-can-decide'),
      valid: node.getAttribute('data-valid'),
    })),
  )
  samples.approvals = { state, cards, approvalsText: clip(approvalsText, 500) }
  const assessed = assessApprovals({ state, controlText, approvalsText, cards })
  return { status: assessed.ok ? 'PASS' : 'FAIL', detail: assessed.detail }
}

/**
 * Insert one pending approval into the private ledger after the host has
 * created the scope. This is fixture data for the click test, not a write-mode
 * bypass: the browser still has to go through boopControl/decideApproval.
 */
function seedPendingApproval(home) {
  const dbPath = path.join(home, 'boop', 'boop.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 8000')
  db.exec('PRAGMA foreign_keys = ON')
  const scope = db.prepare('SELECT scope_id, owner_id, policy_epoch FROM scopes LIMIT 1').get()
  if (!scope) {
    db.close()
    throw new Error(`BOOP ledger has no scope yet: ${dbPath}`)
  }
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const taskId = 'task-e2e-approval'
  const actionId = 'action-e2e-approval'
  const approvalId = 'approval-e2e-1'
  const payloadHash = 'hash-e2e-approval'
  const nonce = 'nonce-e2e-approval'
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,intent_ref,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(taskId, scope.scope_id, 'E2E 审批只落账', 'active', 'not_requested', 1, '["shown"]', '["no-dispatch"]', 'e2e', now, now)
    db.prepare(
      `INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,intent_ref,created_at) VALUES(?,?,?,?,?,?)`,
    ).run(taskId, scope.scope_id, 1, '{"goal":"E2E 审批只落账","criteria":["shown"],"exclusions":["no-dispatch"]}', 'e2e', now)
    db.prepare(
      `INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,message_id,turn_id,policy_epoch,origin_ref,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      actionId,
      scope.scope_id,
      taskId,
      1,
      'session-e2e',
      payloadHash,
      '{"instruction":"do not dispatch"}',
      'awaiting_approval',
      null,
      null,
      Number(scope.policy_epoch),
      'e2e',
      now,
      now,
    )
    db.prepare('INSERT INTO command_outbox(action_id,scope_id,state,attempt) VALUES(?,?,?,?)').run(actionId, scope.scope_id, 'prepared', 0)
    db.prepare(
      `INSERT INTO approval(id,scope_id,action_id,payload_hash,task_version,policy_epoch,requesting_owner,nonce_hash,expires_at,status)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      approvalId,
      scope.scope_id,
      actionId,
      payloadHash,
      1,
      Number(scope.policy_epoch),
      String(scope.owner_id),
      nonce,
      expires,
      'pending',
    )
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* the transaction may already be closed */
    }
    db.close()
    throw error
  }
  db.close()
  return { approvalId, scopeId: scope.scope_id }
}

function approvalStatus(home, approvalId) {
  const db = new DatabaseSync(path.join(home, 'boop', 'boop.sqlite'))
  db.exec('PRAGMA busy_timeout = 8000')
  const row = db.prepare('SELECT status, consumed_at, action_id FROM approval WHERE id = ?').get(approvalId)
  const actions = row
    ? db.prepare('SELECT state FROM action WHERE id = ?').get(row.action_id)
    : null
  db.close()
  return { status: row?.status ?? null, consumedAt: row?.consumed_at ?? null, actionState: actions?.state ?? null }
}

async function runApprovalDecision(page) {
  const seeded = seedPendingApproval(HOME)
  const refresh = page.locator('[data-boop-control-action="refresh"]')
  await refresh.scrollIntoViewIfNeeded()
  await guardedClick(page, refresh, 'refresh control plane')
  const card = page.locator(`[data-boop-approval][data-approval-id="${seeded.approvalId}"]`)
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  const canDecide = await card.getAttribute('data-can-decide')
  const valid = await card.getAttribute('data-valid')
  if (canDecide !== 'true' || valid !== 'true') {
    return { status: 'FAIL', detail: `seeded card is not decidable canDecide=${canDecide} valid=${valid}` }
  }
  await screenshot(page, '09-approval-before')
  await guardedClick(page, card.locator('[data-boop-approval-action="approve"]'), 'approve seeded card')
  // A confirmed decision refreshes the card, so the receipt node can unmount.
  // The pass condition is the ledger plus the card status, with the receipt
  // text captured if it is still on the page.
  const seen = await page.waitForFunction(
    (approvalId) => {
      const receipt = document.querySelector(`#boop-decision-${approvalId}, [data-boop-approval][data-approval-id="${approvalId}"] [data-boop-control-receipt]`)
      const current = document.querySelector(`[data-boop-approval][data-approval-id="${approvalId}"]`)
      const text = receipt?.textContent ?? ''
      const status = current?.getAttribute('data-status') ?? ''
      if (text.includes('仅落账') || status === 'allowed') return { text, status }
      return null
    },
    seeded.approvalId,
    { timeout: 20_000 },
  )
  const captured = await seen.jsonValue()
  await screenshot(page, '10-approval-decided')
  const ledger = approvalStatus(HOME, seeded.approvalId)
  const text = captured.text ?? ''
  samples.approvalDecision = { seeded, text: clip(text, 500), status: captured.status, ledger }
  const recorded = text.includes('仅落账') || captured.status === 'allowed'
  const notDispatched = ledger.actionState === 'awaiting_approval'
  const landed = ledger.status === 'allowed'
  if (!recorded || !notDispatched || !landed) {
    return {
      status: 'FAIL',
      detail: `recorded=${recorded} notDispatched=${notDispatched} ledger=${JSON.stringify(ledger)} ${clip(text, 300)}`,
    }
  }
  return {
    status: 'PASS',
    detail: `clicked 批准本次 on ${seeded.approvalId}; ledger status=${ledger.status}; action stayed ${ledger.actionState}; ${clip(text, 220)}`,
  }
}

function seedStaleApproval(home) {
  const dbPath = path.join(home, 'boop', 'boop.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 8000')
  db.exec('PRAGMA foreign_keys = ON')
  const scope = db.prepare('SELECT scope_id, owner_id, policy_epoch FROM scopes LIMIT 1').get()
  if (!scope) {
    db.close()
    throw new Error(`BOOP ledger has no scope yet: ${dbPath}`)
  }
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const taskId = 'task-e2e-stale'
  const actionId = 'action-e2e-stale'
  const approvalId = 'approval-e2e-stale'
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,intent_ref,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(taskId, scope.scope_id, 'E2E 过期绑定', 'active', 'not_requested', 2, '["shown"]', '["no-dispatch"]', 'e2e', now, now)
    const revision = db.prepare(
      `INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,intent_ref,created_at) VALUES(?,?,?,?,?,?)`,
    )
    revision.run(taskId, scope.scope_id, 1, '{"goal":"E2E 过期绑定","version":1}', 'e2e', now)
    revision.run(taskId, scope.scope_id, 2, '{"goal":"E2E 过期绑定","version":2}', 'e2e', now)
    db.prepare(
      `INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,message_id,turn_id,policy_epoch,origin_ref,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      actionId,
      scope.scope_id,
      taskId,
      1,
      'session-e2e-stale',
      'hash-e2e-stale',
      '{"instruction":"stale binding"}',
      'awaiting_approval',
      null,
      null,
      Number(scope.policy_epoch),
      'e2e',
      now,
      now,
    )
    db.prepare('INSERT INTO command_outbox(action_id,scope_id,state,attempt) VALUES(?,?,?,?)').run(actionId, scope.scope_id, 'prepared', 0)
    db.prepare(
      `INSERT INTO approval(id,scope_id,action_id,payload_hash,task_version,policy_epoch,requesting_owner,nonce_hash,expires_at,status)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      approvalId,
      scope.scope_id,
      actionId,
      'hash-e2e-stale',
      1,
      Number(scope.policy_epoch),
      String(scope.owner_id),
      'nonce-e2e-stale',
      expires,
      'pending',
    )
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* the transaction may already be closed */
    }
    db.close()
    throw error
  }
  db.close()
  return { approvalId }
}

async function runStaleApproval(page) {
  const seeded = seedStaleApproval(HOME)
  const refresh = page.locator('[data-boop-control-action="refresh"]')
  await refresh.scrollIntoViewIfNeeded()
  await guardedClick(page, refresh, 'refresh stale approval')
  const card = page.locator(`[data-boop-approval][data-approval-id="${seeded.approvalId}"]`)
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  const canDecide = await card.getAttribute('data-can-decide')
  const valid = await card.getAttribute('data-valid')
  const text = await card.innerText()
  const approve = card.locator('[data-boop-approval-action="approve"]')
  const disabled = await approve.isDisabled()
  await screenshot(page, '11-stale-approval')
  const ledger = approvalStatus(HOME, seeded.approvalId)
  samples.staleApproval = { canDecide, valid, disabled, ledger, text: clip(text, 400) }
  const moved = text.includes('任务版本已移动')
  const blocked = canDecide === 'false' && valid === 'false' && disabled
  const untouched = ledger.status === 'pending' && ledger.actionState === 'awaiting_approval'
  if (!moved || !blocked || !untouched) {
    return {
      status: 'FAIL',
      detail: `moved=${moved} blocked=${blocked} untouched=${untouched} canDecide=${canDecide} valid=${valid} disabled=${disabled} ledger=${JSON.stringify(ledger)}`,
    }
  }
  return {
    status: 'PASS',
    detail: `${seeded.approvalId} shows 任务版本已移动; approve stays disabled; ledger status stayed pending`,
  }
}

async function runIme(page) {
  const located = await page.evaluate(() => {
    const root = document.querySelector('[data-boop-panel]')
    if (!root) return { present: false, reason: 'BOOP panel is not open' }
    const field = [...root.querySelectorAll('input, textarea')].find((element) => {
      if (element instanceof HTMLTextAreaElement) return true
      if (!(element instanceof HTMLInputElement)) return false
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      return type === 'text' || type === 'search' || type === ''
    })
    if (!field) {
      return {
        present: false,
        reason:
          'no BOOP-owned text field in [data-boop-panel]; stop radios, recovery checkboxes and the taskboard workspace select are not text fields',
      }
    }
    field.setAttribute('data-boop-e2e-ime', '1')
    return {
      present: true,
      aria: field.getAttribute('aria-label'),
      type: field.getAttribute('type'),
      tag: field.tagName,
    }
  })
  if (!located.present) return { status: 'SKIP', detail: located.reason }

  const field = page.locator('[data-boop-e2e-ime="1"]')
  await field.scrollIntoViewIfNeeded()
  await field.click()
  await page.evaluate(() => {
    const target = document.querySelector('[data-boop-e2e-ime="1"]')
    const log = []
    window.__boopImeLog = log
    for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) {
      target.addEventListener(name, (event) => {
        log.push({ name, data: 'data' in event ? event.data : null })
      })
    }
  })

  let transport = 'cdp-imeSetComposition'
  try {
    const client = await page.context().newCDPSession(page)
    await client.send('Input.imeSetComposition', { text: '波', selectionStart: 1, selectionEnd: 1 })
    await client.send('Input.imeSetComposition', { text: COMPOSED, selectionStart: COMPOSED.length, selectionEnd: COMPOSED.length })
    await client.detach().catch(() => {})
  } catch (error) {
    transport = `cdp-unavailable: ${clip(error, 160)}`
  }

  await page.evaluate((composed) => {
    const target = document.querySelector('[data-boop-e2e-ime="1"]')
    const log = window.__boopImeLog ?? []
    const seen = new Set(log.map((entry) => entry.name))
    if (!seen.has('compositionstart')) {
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true, data: '' }))
    }
    if (!seen.has('compositionupdate')) {
      target.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, cancelable: true, data: '波' }))
      target.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, cancelable: true, data: composed }))
    }
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    const previous = target.value
    setter?.call(target, composed)
    if (target._valueTracker && typeof target._valueTracker.setValue === 'function') target._valueTracker.setValue(previous)
    target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: composed, inputType: 'insertFromComposition' }))
    target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true, data: composed }))
  }, COMPOSED)

  await page.waitForTimeout(400)
  const after = await page.evaluate(() => {
    const target = document.querySelector('[data-boop-e2e-ime="1"]')
    const value = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : ''
    return { value, log: window.__boopImeLog ?? [] }
  })
  await field.scrollIntoViewIfNeeded()
  await screenshot(page, '08-ime')
  const names = after.log.map((entry) => entry.name)
  const start = names.indexOf('compositionstart')
  const update = names.indexOf('compositionupdate')
  const end = names.lastIndexOf('compositionend')
  const orderOk = start !== -1 && update > start && end > update
  const duplicated = after.value.includes(`${COMPOSED}${COMPOSED}`)
  samples.ime = { located, transport, events: after.log, value: after.value }
  const detail = `field=${located.aria ?? located.tag} type=${located.type} transport=${transport} events=${names.join('>') || 'none'} value=${JSON.stringify(after.value)}`
  if (!orderOk) return { status: 'FAIL', detail: `composition events did not run in order. ${detail}` }
  if (duplicated) return { status: 'FAIL', detail: `composition duplicated the committed text. ${detail}` }
  if (after.value !== COMPOSED) return { status: 'FAIL', detail: `committed text was not kept. ${detail}` }
  return { status: 'PASS', detail }
}

function markdownReport({ verdict, facts, host, port }) {
  const lines = [
    '# Web E2E — human control (real Edge)',
    '',
    `Verdict: **${verdict}**. This run does not mark any gate PASS and does not edit STATUS.md. Write mode follows the gate ledger. Approval, stop, and recovery still do not dispatch.`,
    '',
    blocker ? `Blocker: ${clip(blocker, 700)}` : 'Blocker: none for the control steps.',
    '',
    'Channels stay closed on the main host row. This profile does not disable a BOOP row and does not set a write-mode flag.',
    '',
    '| Item | Value |',
    '| --- | --- |',
    `| Browser | ${EDGE_CHANNEL}${facts?.browserVersion ? ` ${facts.browserVersion}` : ''} |`,
    `| Host | DSH ${facts?.dshVersion ?? 'unknown'} |`,
    `| Private DSH_HOME | \`${rel(HOME)}\` |`,
    `| URL | ${host ? host.url.split('?')[0] : 'not booted'} |`,
    `| Port | ${port ?? 'n/a'} |`,
    '',
    '## Steps',
    '',
    '| Status | Step | Detail |',
    '| --- | --- | --- |',
    ...steps.map((step) => `| ${step.status} | ${step.name.replaceAll('|', '/')} | ${(step.detail ?? '').replaceAll('|', '/').replaceAll('\n', ' ')} |`),
    '',
    '## What was checked',
    '',
    '- Stop uses the scope-all control `停止全部 BOOP 动作` (`[data-boop-stop-action="stop"]`, radio `value="all"`). An empty board must read as noop (`没有可停止内容`, `noop=true`, `不是“已撤销成功”`) together with `请求已发送 ≠ 外部副作用已撤销`. A refusal that says the ledger was not changed is also honest. A stopped-item list with no actions on the board is a failure.',
    '- Recovery is `[data-boop-recovery]`. There must be no select-all control. With zero checked message ids, `释放选中（0）` must not produce a success that released everything. The standing copy is `必须逐项` / `未勾选的旧 BOOP 命令保持阻断`. A host `INVALID_ARGUMENT` receipt is a refusal.',
    '- Approvals: a ready board with nothing pending must show `服务端确认：当前没有等待你决定的有效审批（不是读取失败）。` and no decidable pending card. A failed read must not be presented as zero pending.',
    '- IME: one composition (`compositionstart` / `compositionupdate` / `compositionend`) on a BOOP-owned text field inside `[data-boop-panel]`, when one exists. A missing field is SKIP, not a failure.',
    '',
    '## Screenshots',
    '',
    ...(shots.length > 0 ? shots.map((shot) => `- \`${shot}\``) : ['- none']),
    '',
  ]
  return `${lines.join('\n')}\n`
}

function writeEvidence({ verdict, facts, host, port }) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const summary = {
    schemaVersion: 1,
    verdict,
    capturedAt: new Date().toISOString(),
    blocker,
    gatesMarkedPass: false,
    writeModeEnabledByHarness: false,
    browser: { channel: EDGE_CHANNEL, version: facts?.browserVersion ?? null },
    host: host
      ? {
          url: host.url.split('?')[0],
          port,
          dshVersion: facts?.dshVersion ?? null,
          dshHome: rel(HOME),
          profile: PROFILE,
        }
      : null,
    steps,
    samples,
    shots,
    consoleNotes: consoleNotes.slice(-80),
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(path.join(OUT, 'report.md'), markdownReport({ verdict, facts, host, port }))
}

async function main() {
  assertPrivateHome(HOME)
  fs.mkdirSync(SHOTS, { recursive: true })
  if (!process.env.BOOP_QWEN_KEY) process.env.BOOP_QWEN_KEY = 'placeholder'

  let host = null
  let browser = null
  let page = null
  let port = null
  let facts = null
  let browserVersion = null

  try {
    facts = hostFacts()
    if (facts.dshVersion !== EXPECTED_DSH) {
      throw new Error(`expected DSH ${EXPECTED_DSH}, payload reports ${facts.dshVersion}`)
    }
    console.log(`preparing private profile under ${rel(HOME)}`)
    await prepareProfile()
    record(PLANNED[0], 'PASS', `${PROFILE}; DSH_HOME=${rel(HOME)}; write mode follows the gate ledger`)

    port = await freePort()
    console.log(`booting web host on 127.0.0.1:${port}`)
    host = await bootWeb({ home: HOME, profile: PROFILE, port })
    record(PLANNED[1], 'PASS', `port ${port}; ${host.url.split('?')[0]}`)

    browser = await chromium.launch({ channel: EDGE_CHANNEL, headless: true })
    browserVersion = browser.version()
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
      deviceScaleFactor: 1,
    })
    page = await context.newPage()
    page.on('console', (message) => consoleNotes.push(`${message.type()}: ${message.text().slice(0, 240)}`))
    page.on('pageerror', (error) => consoleNotes.push(`pageerror: ${String(error).slice(0, 240)}`))

    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(3500)
    const masks = await closeBlockingDialogs(page)
    if (masks !== 0) {
      await screenshot(page, 'failure-dialog').catch(() => {})
      record(PLANNED[2], 'FAIL', `click-blocking masks remain: ${masks} ${clip(JSON.stringify(await dialogDiagnostics(page)), 400)}`)
      fillNotRun('Edge shell still has a blocking dialog')
      return
    }
    await page.waitForTimeout(800)
    await openWorkspace(page)
    await screenshot(page, '01-shell-1280x800')
    const title = await page.title()
    if (!title) {
      record(PLANNED[2], 'FAIL', 'Edge loaded a page with an empty title')
      fillNotRun('Edge shell was not usable')
      return
    }
    record(PLANNED[2], 'PASS', `title=${JSON.stringify(title)} url=${page.url().split('?')[0]}`)

    let board
    try {
      board = await openBoard(page)
    } catch (error) {
      await screenshot(page, 'failure-board').catch(() => {})
      record(PLANNED[3], 'FAIL', clip(error, 800))
      fillNotRun('BOOP task board did not open')
      return
    }
    record(PLANNED[3], board.ok ? 'PASS' : 'FAIL', board.detail)
    if (!board.ok || !board.writeModeOn || !board.dispatchClosed) {
      fillNotRun(board.ok ? 'control row is not in the open-ledger shape; control commands were not sent' : 'BOOP task board did not open')
      return
    }

    const interactions = [
      [PLANNED[4], () => runStop(page), 'failure-stop'],
      [PLANNED[5], () => runRecovery(page), 'failure-recovery'],
      [PLANNED[6], () => runApprovals(page), 'failure-approvals'],
      [PLANNED[7], () => runApprovalDecision(page), 'failure-approval-decision'],
      [PLANNED[8], () => runStaleApproval(page), 'failure-stale-approval'],
      [PLANNED[9], () => runIme(page), 'failure-ime'],
    ]
    for (const [name, run, shot] of interactions) {
      try {
        const outcome = await run()
        record(name, outcome.status, outcome.detail)
      } catch (error) {
        await screenshot(page, shot).catch(() => {})
        record(name, 'FAIL', clip(error, 800))
      }
    }
  } catch (error) {
    blocker = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    console.error(blocker)
    if (page) await screenshot(page, 'failure').catch(() => {})
    fillNotRun(clip(blocker, 500))
  } finally {
    facts = { ...(facts ?? {}), browserVersion }
    const verdict = verdictOf()
    try {
      writeEvidence({ verdict, facts, host, port })
      console.log(`EVIDENCE ${rel(OUT)}`)
      console.log(`VERDICT ${verdict}`)
    } catch (error) {
      console.error(`evidence write failed: ${String(error)}`)
    }
    if (browser && !args.includes('--keep')) await browser.close().catch(() => {})
    if (host) await host.stop().catch(() => {})
    process.exit(verdict === 'PASS' ? 0 : 1)
  }
}

main()
