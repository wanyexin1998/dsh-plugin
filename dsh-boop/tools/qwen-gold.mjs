#!/usr/bin/env node
/**
 * E05-00 real-gold runner (G02).
 *
 * Runs the frozen probe ladder against the user's actual Qwen service and
 * writes desensitized evidence under docs/development/evidence/e05-00/.
 *
 * Configuration comes from the environment; nothing is guessed and no secret is
 * ever written to the evidence:
 *
 *   BOOP_QWEN_BASE_URL   required, e.g. http://172.26.0.49:8000/v1
 *   BOOP_QWEN_MODEL      required model id exactly as served, e.g. qwen3.8-27b
 *   BOOP_QWEN_PROVIDER_ID  optional label, default qwen-vllm-local
 *   BOOP_QWEN_KEY        optional credential for the endpoint; when unset the
 *                        config states `credential: none` explicitly
 *   BOOP_QWEN_DECLARED_CONTEXT  optional label, default 196k
 *   BOOP_QWEN_QUANTIZATION      optional, default 4bit
 *   BOOP_QWEN_NEAR_LIMIT   optional integer tokens for a near-limit request
 *   BOOP_QWEN_OVER_LIMIT   optional integer tokens for an over-limit request
 *
 * Usage:
 *   node tools/qwen-gold.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MODEL_CONFIG } from '../src/host/model/qwen-adapter.ts'
import { NO_CREDENTIAL } from '../src/host/model/qwen-client.ts'
import { runGoldProbe } from '../src/host/model/qwen-probe.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'docs', 'development', 'evidence', 'e05-00')

function intEnv(name) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const baseUrl = process.env.BOOP_QWEN_BASE_URL?.trim()
const modelId = process.env.BOOP_QWEN_MODEL?.trim()
if (!baseUrl || !modelId) {
  console.error('BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL are required (real gold run is opt-in).')
  process.exit(2)
}

const config = {
  ...DEFAULT_MODEL_CONFIG,
  providerId: process.env.BOOP_QWEN_PROVIDER_ID?.trim() || 'qwen-vllm-local',
  modelId,
  baseUrl,
  credentialRef: process.env.BOOP_QWEN_KEY ? 'env:BOOP_QWEN_KEY' : NO_CREDENTIAL,
  declaredContext: process.env.BOOP_QWEN_DECLARED_CONTEXT?.trim() || '196k',
  quantization: process.env.BOOP_QWEN_QUANTIZATION?.trim() || '4bit',
}

console.log('E05-00 real gold probe')
console.log(`  provider : ${config.providerId}`)
console.log(`  model    : ${config.modelId}`)
console.log(`  base URL : ${config.baseUrl}`)
console.log(`  credential: ${config.credentialRef === NO_CREDENTIAL ? 'none (explicit)' : 'reference (env)'}`)

const evidence = await runGoldProbe(config, {
  nearLimitTokens: intEnv('BOOP_QWEN_NEAR_LIMIT'),
  overLimitTokens: intEnv('BOOP_QWEN_OVER_LIMIT'),
})

fs.mkdirSync(OUT_DIR, { recursive: true })
const stamp = evidence.startedAt.replace(/[:.]/gu, '-')
const jsonFile = path.join(OUT_DIR, `qwen-gold-${stamp}.json`)
fs.writeFileSync(jsonFile, `${JSON.stringify(evidence, null, 2)}\n`)

const lines = []
lines.push('# E05-00 · 自有 Qwen 真实金标报告（G02）')
lines.push('')
lines.push(`> 运行时间：${evidence.startedAt}（耗时 ${(evidence.elapsedMs / 1000).toFixed(1)}s）`)
lines.push('> 由 `tools/qwen-gold.mjs` 生成；配置脱敏，不包含任何密钥。')
lines.push('')
lines.push('## 0. 结论')
lines.push('')
lines.push(`- 有效上下文整数（服务端报告）：**${evidence.contextWindowTokens ?? 'unknown'}** tokens（声明标签：${evidence.config.declaredContext ?? '未声明'}；模型名不参与推断）`)
lines.push(`- 服务端：\`${evidence.config.baseUrl}\`；模型 \`${evidence.config.modelId}\`；root \`${evidence.server.root ?? 'unknown'}\`；量化 \`${evidence.config.quantization ?? 'unknown'}\``)
lines.push(`- 凭证：${evidence.config.credential === 'none' ? '**无凭证**（配置显式声明 none）' : '引用环境变量（未落盘）'}`)
lines.push(`- 外部回退：${evidence.config.externalFallbackAllowed ? '允许（违规）' : '**禁止**'}`)
lines.push('')
lines.push('| 能力 | 结果 | 证据 |')
lines.push('|---|---|---|')
for (const step of evidence.steps) {
  lines.push(`| ${step.id} | **${step.state}** | ${step.detail.replace(/\|/gu, '\\|')} |`)
}
lines.push('')
lines.push('## 1. 能力映射（由熔断规则决定，不是打分）')
lines.push('')
lines.push('| 能力 | 允许 |')
lines.push('|---|---|')
lines.push(`| 只读聊天 | ${evidence.outcome.allowed.readOnlyChat ? '✅' : '❌'} |`)
lines.push(`| 记忆提取 job | ${evidence.outcome.allowed.memoryJobs ? '✅' : '❌'} |`)
lines.push(`| 自主派发 | ${evidence.outcome.allowed.autonomousDispatch ? '✅' : '❌'} |`)
lines.push(`| 历史批量学习 | ${evidence.outcome.allowed.historyBatchLearning ? '✅' : '❌'} |`)
lines.push('')
lines.push('## 2. 上下文与边界观测')
lines.push('')
lines.push(`- 分长度实测 prompt tokens：${evidence.observations.ladderPromptTokens.join(' / ')}（目标 8k / 32k / 64k）`)
if (evidence.observations.nearLimit) {
  const near = evidence.observations.nearLimit
  lines.push(`- 接近上限请求：目标 ~${near.requestedTokens} tokens → HTTP ${near.status}，实测 prompt_tokens=${near.promptTokens ?? 'n/a'}，finish=${near.finish ?? 'n/a'}，耗时 ${(near.elapsedMs / 1000).toFixed(1)}s`)
}
if (evidence.observations.overLimit) {
  const over = evidence.observations.overLimit
  lines.push(`- 超上限请求：目标 ~${over.requestedTokens} tokens → HTTP ${over.status}；${over.behavior}`)
}
lines.push('- 预算规则：`input + outputReserve + safetyMargin <= effectiveContextLimit`（`clampRequest`）；196k 标签不作为预算。')
lines.push('')
lines.push('## 3. 复现命令')
lines.push('')
lines.push('```powershell')
lines.push('$env:BOOP_QWEN_BASE_URL="' + String(evidence.config.baseUrl) + '"')
lines.push('$env:BOOP_QWEN_MODEL="' + String(evidence.config.modelId) + '"')
lines.push('node tools/qwen-gold.mjs')
lines.push('```')
lines.push('')
lines.push(`原始 JSON：[qwen-gold-${stamp}.json](qwen-gold-${stamp}.json)`)
lines.push('')

const mdFile = path.join(OUT_DIR, 'qwen-gold-report.md')
fs.writeFileSync(mdFile, `${lines.join('\n')}\n`)

console.log('')
for (const step of evidence.steps) console.log(`  ${step.state.padEnd(7)} ${step.id.padEnd(18)} ${step.detail}`)
console.log('')
console.log(`effective context: ${evidence.contextWindowTokens} tokens`)
console.log(`allowed: ${JSON.stringify(evidence.outcome.allowed)}`)
console.log(`json: ${jsonFile}`)
console.log(`report: ${mdFile}`)
