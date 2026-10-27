import * as React from 'react'

import type { ReactElement } from 'react'

import type { TestResult } from '../api.ts'
import { classes as styles } from '../styles.ts'

/**
 * Connection-test verdict: one dot plus the reason, mirroring DataGrip's
 * ThreeState + ErrorInfo pair (SPEC §4, docs/03 §4.5).
 */
export function TestStateBadge({ result, busy }: { readonly result?: TestResult; readonly busy?: boolean }): ReactElement {
  if (busy === true) {
    return (
      <span className={styles.badge} data-test-state="testing" role="status">
        <span className={styles.dotPending} aria-hidden="true" /> 正在连接…
      </span>
    )
  }
  if (result === undefined) {
    return (
      <span className={styles.badge}>
        <span className={styles.dotIdle} aria-hidden="true" />
        未测试
      </span>
    )
  }

  if (result.state === 'YES') {
    const info = result.info
    return (
      <span className={styles.badge} data-test-state="YES" title={`${result.durationMs}ms`}>
        <span className={styles.dotOk} aria-hidden="true" />
        {info === undefined ? '连接成功' : `${info.product} ${info.version}${info.exactVersion === undefined ? '' : ` (${info.exactVersion})`} · ${info.driverVersion}`}
      </span>
    )
  }

  return (
    <span className={styles.badge} data-test-state={result.state}>
      <span className={result.state === 'NO' ? styles.dotBad : styles.dotPending} aria-hidden="true" />
      {result.error?.message ?? '连接失败'}
      {result.error?.hint === undefined ? null : <em className={styles.hint}> · {result.error.hint}</em>}
    </span>
  )
}
