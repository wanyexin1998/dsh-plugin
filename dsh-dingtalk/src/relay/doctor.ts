import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Config } from '../config.js'
import { feedbackEvents } from '../feedback.js'
import type { DoctorReport, DoctorMode, DoctorCheck } from '../doctor-report.js'

async function json(file: string) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return {}
  }
}
function safeFeedback(value: any) {
  return Object.fromEntries(
    feedbackEvents.flatMap((key) => {
      const row = value?.events?.[key]
      if (!row || ![row.success, row.failure, row.at].every((x) => Number.isSafeInteger(x) && x >= 0)) return []
      return [
        [
          key,
          {
            success: row.success,
            failure: row.failure,
            at: row.at,
            code: ['ok', 'permission', 'rate_limit', 'timeout', 'transport', 'rejected'].includes(row.code)
              ? row.code
              : 'rejected',
          },
        ],
      ]
    }),
  )
}
/** Relay diagnostics never inspect local robot secrets or the unrelated web profile. */
export async function relayDoctor(
  home: string,
  profile: string,
  state: string,
  mode: DoctorMode,
): Promise<DoctorReport | undefined> {
  let entries: any
  try {
    entries = parse(await readFile(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8'))
  } catch {
    return undefined
  }
  const entry = Array.isArray(entries) ? entries.find((x) => x?.id === 'dingtalk-channel') : undefined
  if (entry?.config?.relay !== true) return undefined
  const cfg = Config(entry.config)
  const runtime = await json(join(state, 'relay-runtime.json'))
  const current = Date.now() - runtime.observedAt < 30000 && runtime.observedAt <= Date.now()
  const connected = current && runtime.status === 'connected' && entry.disabled !== true
  const checks: DoctorCheck[] = [
    {
      id: 'relay',
      status: connected ? 'pass' : 'warning',
      code: connected ? 'relay.connected' : 'relay.unverified',
      message: connected ? '共享网关连接正常' : '共享网关连接未就绪或状态已过期',
    },
  ]
  const feedback = safeFeedback(await json(join(state, 'accounts/shared/feedback.json')))
  const gateway = safeFeedback(runtime.gateway)
  const cardEvents = ['card.create', 'card.deliver', 'card.stream', 'card.finish']
  const cardFailed = cardEvents.some((name) => gateway[name] && gateway[name].code !== 'ok')
  const cardVerified = cardEvents.every((name) => gateway[name]?.success > 0)
  checks.push({
    id: 'ai-card',
    status: cardFailed ? 'fail' : cardVerified ? 'pass' : 'unverified',
    code: cardFailed ? 'ai-card.unavailable' : cardVerified ? 'ai-card.verified' : 'ai-card.unverified',
    message: cardFailed
      ? '最近卡片 API 调用失败，请查看脱敏诊断类别'
      : cardVerified
        ? '当前网关已完成卡片创建、投放、流式更新及结束'
        : '当前网关尚未完成卡片全链路验证',
  })
  return {
    schemaVersion: 1,
    kind: 'doctor-report',
    mode,
    result: cardFailed ? 'fail' : !connected ? 'warning' : cardVerified ? 'pass' : 'unverified',
    checks,
    accounts: [],
    digitalEmployees: [],
    summary: {
      total: 2,
      pass: (connected ? 1 : 0) + (!cardFailed && cardVerified ? 1 : 0),
      warning: connected ? 0 : 1,
      fail: cardFailed ? 1 : 0,
      error: 0,
      unverified: !cardFailed && !cardVerified ? 1 : 0,
    },
    channel: 'robot-relay',
    profile,
    effective: {
      replyMode: cfg.replyMode,
      streaming: cfg.streaming,
      asyncMode: cfg.asyncMode,
      emotionFirstResponse: cfg.emotionFirstResponse,
    },
    feedback: { renderer: feedback, gateway },
  }
}
