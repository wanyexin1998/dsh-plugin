#!/usr/bin/env node
/**
 * Render the real home components to screenshots.
 * The composer in this gallery is the reserved native slot, not a second editor.
 */
import * as esbuild from 'esbuild-wasm'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const outDir = process.env.BOOP_PREVIEW_OUT ?? '/opt/cursor/artifacts'
fs.mkdirSync(outDir, { recursive: true })
const bundlePath = path.join(outDir, 'boop-home-preview.js')
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/client/home/preview.tsx'],
  bundle: true,
  format: 'iife',
  outfile: bundlePath,
  platform: 'browser',
  target: 'chrome126',
  jsx: 'automatic',
  logLevel: 'warning',
})
const js = fs.readFileSync(bundlePath, 'utf8')
const htmlPath = path.join(outDir, 'boop-home-preview.html')
fs.writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><title>BOOP · 波波</title></head><body style="margin:0;background:#d5d8de"><div id="root"></div><script>${js}</script></body></html>`)

const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
await page.goto(htmlPath.startsWith('/') ? `file://${htmlPath}` : htmlPath, { waitUntil: 'load' })
await page.locator('[data-preview="welcome-light"]').screenshot({ path: path.join(outDir, 'boop-home-welcome-light.png') })
await page.locator('[data-preview="working-dark"]').screenshot({ path: path.join(outDir, 'boop-home-working-dark.png') })
await page.locator('[data-preview="narrow"]').screenshot({ path: path.join(outDir, 'boop-home-narrow.png') })
await page.locator('[data-preview="settings"]').screenshot({ path: path.join(outDir, 'boop-home-settings.png') })
await browser.close()
console.log(JSON.stringify({ outDir, files: ['boop-home-welcome-light.png', 'boop-home-working-dark.png', 'boop-home-narrow.png', 'boop-home-settings.png'] }))
