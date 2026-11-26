import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const log = fs.readFileSync(path.join(root, '.runtime/server.log'), 'utf8')
const url = log.match(/http:\/\/127\.0\.0\.1:19423\/\?token=\S+/)?.[0]
if (!url) throw new Error('DSH URL is not ready')
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.goto(url, { waitUntil: 'networkidle' })
const continueButton = page.getByRole('button', { name: '继续', exact: true })
if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
const p1 = page.getByText('P1 参数测算验收', { exact: true }).first()
const v2 = page.getByText('V2 核心体验验收', { exact: true }).first()
const advanced = page.getByText('高级组件验收', { exact: true }).first()
const basic = page.getByText('可视化现金流验收', { exact: true }).first()
let openedSession = false
if (await p1.isVisible().catch(() => false)) {
  await p1.click()
  openedSession = true
} else if (await v2.isVisible().catch(() => false)) {
  await v2.click()
  openedSession = true
} else if (await advanced.isVisible().catch(() => false)) {
  await advanced.click()
  openedSession = true
} else if (await basic.isVisible().catch(() => false)) {
  await basic.click()
  openedSession = true
}
if (openedSession) await page.locator('.dsh-vi-chart').last().waitFor({ state: 'visible', timeout: 15000 })
const target = new URL(page.url())
const token = new URL(url).searchParams.get('token')
if (!token) throw new Error('DSH access token is missing')
target.searchParams.set('token', token)
await browser.close()
const child = spawn('cmd.exe', ['/c', 'start', '', target.toString()], { detached: true, stdio: 'ignore' })
child.unref()
console.log('Opened the latest Visualize Inline acceptance session in the default browser.')
