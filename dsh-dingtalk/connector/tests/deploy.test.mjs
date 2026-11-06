import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const deploy = join(root, 'deploy')
const dockerfile = await readFile(join(root, 'docker', 'Dockerfile'), 'utf8')
const dockerignore = await readFile(join(root, '..', '.dockerignore'), 'utf8')
const compose = await readFile(join(deploy, 'compose.yaml'), 'utf8')
const gatewayCompose = await readFile(join(deploy, 'gateway.compose.yaml'), 'utf8')
const nginx = await readFile(join(deploy, 'nginx-oauth.conf.example'), 'utf8')
const section = (text, start, end) => {
  const from = text.indexOf(start)
  const to = text.indexOf(end)
  assert.ok(from >= 0 && to > from, `missing ${start}`)
  return text.slice(from, to)
}
const dockerComposeAvailable = () => spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0

test('deployment templates reference files that exist and keep the gateway off by default', async () => {
  for (const file of [
    'connector.env.example',
    'nginx-oauth.conf.example',
    'gateway.compose.yaml',
    'gateway/gateway.env.example',
    'gateway/gateway.json.example',
  ]) {
    await stat(join(deploy, file))
  }
  assert.match(gatewayCompose, /profiles:\s*\[['"]robot['"]\]/)
  assert.match(gatewayCompose, /\.\/gateway\.env/)
  assert.match(gatewayCompose, /\.\/gateway\.json/)
  assert.match(gatewayCompose, /dsh-dingtalk-gateway/)
  // The Connector template itself never references the gateway service.
  assert.ok(!/^\s{2}gateway:/m.test(compose), 'the default template has no gateway service')
})
test('shared network namespace publishes only the proxy TLS port on the namespace owner', () => {
  const connectorService = section(compose, '  connector:', '  oauth-tls:')
  const proxyService = section(compose, '  oauth-tls:', '\nvolumes:')
  assert.match(connectorService, /ports:/)
  assert.match(connectorService, /'?\$\{OAUTH_PUBLIC_PORT:-443\}:8443'?/)
  assert.match(proxyService, /network_mode:\s*'service:connector'/)
  assert.ok(!proxyService.includes('ports:'), 'a service sharing another network namespace must not declare ports')
  assert.ok(!compose.includes('8787:'), 'the internal OAuth listener is never published')
})
test('nginx TLS proxy keeps only the capabilities required to start and drop worker privileges', () => {
  const proxyService = section(compose, '  oauth-tls:', '\nvolumes:')
  assert.match(proxyService, /cap_drop:\s*\n\s*- ALL/)
  for (const cap of ['NET_BIND_SERVICE', 'CHOWN', 'SETUID', 'SETGID'])
    assert.match(proxyService, new RegExp(`- ${cap}\\b`))
})
test('nginx OAuth proxy replaces raw error logs with allowlisted diagnostics', () => {
  const active = nginx.replace(/^\s*#.*$/gm, '')
  assert.match(active, /error_log \/dev\/null;/)
  assert.match(active, /access_log \/dev\/stdout dsh_oauth_safe;/)
  assert.equal((active.match(/error_log /g) ?? []).length, 1)
  assert.equal((active.match(/access_log /g) ?? []).length, 1)
  const format = active.match(/log_format dsh_oauth_safe escape=json([\s\S]*?);/)[1]
  assert.deepEqual(
    [...format.matchAll(/\$[a-z_0-9]+/g)].map(([name]) => name),
    [
      '$time_iso8601',
      '$request_id',
      '$dsh_oauth_stage',
      '$dsh_oauth_error_code',
      '$status',
      '$upstream_status',
      '$request_time',
      '$upstream_connect_time',
      '$upstream_header_time',
      '$upstream_response_time',
    ],
  )
  // Stage values must be constants: unknown paths, including secrets in a path, become "other".
  const stage = active.match(/map \$uri \$dsh_oauth_stage\s*{([^}]+)}/)[1]
  assert.deepEqual(
    stage
      .trim()
      .split(/;\s*/)
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/)),
    [
      ['default', 'other'],
      ['/dsh-dingtalk/start', 'oauth_start'],
      ['/dsh-dingtalk/callback', 'oauth_callback'],
    ],
  )
  const codes = active.match(/map \$status \$dsh_oauth_error_code\s*{([^}]+)}/)[1]
  assert.ok(!codes.includes('$'), 'error codes must not interpolate request data')
  assert.match(active, /add_header X-Request-ID \$request_id always;/)
  assert.match(active, /proxy_set_header X-Request-ID \$request_id;/)
  assert.match(active, /proxy_hide_header X-Request-ID;/)
  assert.match(active, /proxy_set_header X-Forwarded-Proto https;/)
  assert.match(active, /proxy_set_header Cookie \$http_cookie;/)
})
test('production Dockerfile builds the Connector from source without a pre-existing lib', () => {
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS connector-build/)
  assert.match(dockerfile, /npm ci --ignore-scripts/)
  assert.match(dockerfile, /RUN node scripts\/build\.mjs/)
  assert.match(dockerfile, /COPY --from=connector-build .*\/lib \.\/lib/)
  assert.ok(!dockerfile.includes('COPY connector/lib'), 'the runtime image must not copy a host-built lib')
  assert.ok(!dockerignore.includes('connector/src'), '.dockerignore must ship connector sources for the builder stage')
  assert.ok(!dockerignore.includes('connector/scripts'), '.dockerignore must ship the build script')
  assert.ok(!dockerignore.includes('enhancements/src'), '.dockerignore must ship enhancements sources for bundling')
  assert.ok(!dockerignore.includes('connector/package-lock.json'), 'the lockfile must stay in the build context')
  assert.match(dockerignore, /connector\/lib/)
})
test('compose templates parse and resolve to isolated services', { skip: !dockerComposeAvailable() }, async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'dsh-deploy-'))
  const tls = join(isolated, 'tls')
  try {
    await cp(deploy, isolated, { recursive: true })
    await writeFile(join(isolated, 'connector.env'), 'DSH_CONNECTOR_DWS_BINARY=/opt/dws/bin/dws\n')
    await writeFile(join(isolated, 'gateway.env'), 'NODE_OPTIONS=--max-old-space-size=256\n')
    await writeFile(
      join(isolated, 'gateway.json'),
      JSON.stringify({
        clientId: 'x',
        clientSecret: 'y',
        corpId: 'z',
        stateDirectory: '/var/lib/dsh-dingtalk-gateway',
        publicOrigin: 'https://dsh.test',
      }),
    )
    await import('node:fs/promises').then((fs) => fs.mkdir(tls, { recursive: true }))
    const env = {
      ...process.env,
      CONNECTOR_IMAGE: 'dsh-dingtalk-connector:test',
      OAUTH_TLS_DIR: tls,
      OAUTH_PUBLIC_PORT: '8443',
    }
    const connector = spawnSync('docker', ['compose', '-f', join(isolated, 'compose.yaml'), 'config'], {
      encoding: 'utf8',
      env,
    })
    assert.equal(connector.status, 0, connector.stderr)
    assert.match(connector.stdout, /purpose: ingress|mode: ingress|published: "8443"/)
    assert.equal((connector.stdout.match(/published: "8443"/g) ?? []).length, 1)
    assert.ok(!/published: "8787"/.test(connector.stdout))
    const gateway = spawnSync(
      'docker',
      ['compose', '-f', join(isolated, 'gateway.compose.yaml'), '--profile', 'robot', 'config'],
      { encoding: 'utf8', env: { ...env, GATEWAY_IMAGE: 'dsh-dingtalk-gateway:test' } },
    )
    assert.equal(gateway.status, 0, gateway.stderr)
    assert.match(gateway.stdout, /-\s*robot/)
    assert.match(gateway.stdout, /\/var\/lib\/dsh-dingtalk-gateway/)
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
})
