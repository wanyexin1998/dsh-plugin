/**
 * Isolated DSH test host harness (E00-01 and later host-side gates).
 *
 * Boots the INSTALLED rc.2.1 payload (`@deepseek-ai/dsh` CLI) with a private
 * `$DSH_HOME`, so the user's real `~/.dsh` is never read or modified. The
 * payload root defaults to the extracted copy under
 * `.work/test-host/payload-0.2.1/dsh` (produced by
 * `tools/build-test-payload.mjs`) and can be overridden with DSH_PAYLOAD.
 *
 * The same installed payload was rc.2.0 when E00–E04 evidence was recorded;
 * the rc.2.1 alignment run reuses this harness with the new extraction.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const PAYLOAD_ROOT =
  process.env.DSH_PAYLOAD ?? path.join(PROJECT_ROOT, '.work/test-host/payload-0.2.1/dsh')
export const NODE_BIN =
  process.env.DSH_NODE ??
  'C:/Users/wanyexin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
export const CLI_ENTRY = path.join(
  PAYLOAD_ROOT,
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
)

/** Host facts recorded with every piece of evidence. */
export function hostFacts() {
  const version = JSON.parse(
    fs.readFileSync(path.join(PAYLOAD_ROOT, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'),
  ).version
  return {
    payload: PAYLOAD_ROOT,
    dshVersion: version,
    // Declared desktop build commit (app.asar root package.json `dshBuildCommit`);
    // the installed artifact carries no independent commit metadata.
    pinnedCommit: '332895e0f7c9d4dbfb29729f5eb367fa263ff986',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  }
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export function makeHome(workRoot) {
  const dir = path.join(workRoot)
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true })
  return dir
}

/** Create a profile from the shipped `web` template, then patch its manifest. */
export async function createProfile(home, name, { dependencies = {}, bundles } = {}) {
  await runCli({ home, args: ['--profile', name, '--from-default-profile', 'web', '--dump-config'] })
  const dir = path.join(home, 'profiles', name)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, ...dependencies }
  if (bundles) manifest.dsh.profile.bundles = bundles
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await pnpmInstall(dir)
  return dir
}

export function pnpmInstall(dir) {
  const pnpm = path.resolve(
    'C:/Users/wanyexin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs',
  )
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [pnpm, 'install'], { cwd: dir, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(code) : reject(new Error(`pnpm install failed: ${code}`))))
  })
}

export function runCli({ home, args, timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [CLI_ENTRY, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c.toString()))
    child.stderr.on('data', (c) => (err += c.toString()))
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: out, stderr: err })
    })
  })
}

/**
 * Boot `dsh --profile <name> --no-open --port <port>` and resolve once the
 * startup URL is printed.
 */
export async function bootWeb({ home, profile, port, timeoutMs = 180000 }) {
  const child = spawn(
    NODE_BIN,
    [CLI_ENTRY, '--profile', profile, '--no-open', '--port', String(port)],
    { cwd: PROJECT_ROOT, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => (out += c.toString()))
  child.stderr.on('data', (c) => (err += c.toString()))

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`web boot timed out\nstdout: ${out}\nstderr: ${err}`)), timeoutMs)
    const check = () => {
      const match = /dsh web: (\S+)/.exec(out + err)
      if (!match) {
        setTimeout(check, 250)
        return
      }
      clearTimeout(timer)
      resolve(match[1])
    }
    check()
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`web exited early (${code})\nstdout: ${out}\nstderr: ${err}`))
    })
  })

  const url = await ready
  const token = new URL(url).searchParams.get('token')
  // Strip the query and any trailing slash: callers join paths onto this base.
  const base = url.split('?')[0].replace(/\/+$/, '')
  return {
    child,
    url,
    base,
    token,
    diagnostics: { out, err },
    async stop() {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    },
  }
}

/** Exchange the launch token for the signed browser cookie. */
export async function authorize(base, token) {
  const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) throw new Error(`no cookie granted (status ${response.status})`)
  return setCookie.split(';')[0]
}

/**
 * One authenticated unary RPC call over the `/api` channel.
 * The Gateway's wire payload is exactly one plain-object `args` field.
 */
export async function rpc(base, cookie, endpoint, args = {}) {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'test-' + Math.random().toString(16).slice(2),
      method: endpoint,
      payload: { args },
    }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

/** Unauthenticated request (no cookie, no token) — used by the trust assertions. */
export async function anonymousRequest(target, init) {
  const response = await fetch(target, { redirect: 'manual', ...init })
  return { status: response.status, body: await response.text() }
}
