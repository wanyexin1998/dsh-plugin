/**
 * Static gallery of the real home components.
 * The native composer is represented here only as the slot the factory owns
 * in DSH. This file is not the product entry.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BOOP_HOME_CSS } from './home-styles.ts'
import { BoopHeader } from './Header.tsx'
import { BoopWelcome } from './Welcome.tsx'
import { WorkCard } from './WorkCard.tsx'
import { WorkDrawer } from './WorkDrawer.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
import type { TaskView } from '../../shared/mvp-contract.ts'

const task: TaskView = {
  taskId: 'tsk-preview',
  taskVersion: 1,
  stateSeq: 3,
  title: '检查 Cellgent 分屏的窄屏效果',
  target: { sessionId: 'sess-preview', workspaceId: 'ws', sessionTitle: '原开发会话', workspaceTitle: 'Cellgent' },
  productState: 'running',
  statusText: '正在检查窄屏问题，有结果会告诉你',
  needsAttentionReason: null,
  latestAction: { actionId: 'act', executionState: 'running', stopRequested: false },
  latestResult: null,
  confirmation: { state: 'unavailable' },
  verification: { state: 'not_checked', summary: '还没有可定位的检查结果。', checks: [] },
  availableActions: ['view', 'open_session', 'stop'],
  updatedAt: '2026-10-28T03:00:00.000Z',
}

const delivered: TaskView = {
  ...task,
  title: '修复窄屏标题换行',
  productState: 'delivered',
  statusText: '已交付，可以查看结果',
  latestAction: { actionId: 'act', executionState: 'settled', stopRequested: false },
  latestResult: {
    resultId: 'res',
    taskVersion: 1,
    actionId: 'act',
    kind: 'final',
    outcome: 'completed',
    summary: '调整了标题宽度和换行。检查日志已附在原会话。',
    artifacts: [],
    evidence: [],
    missing: ['没有自动把检查改成通过'],
    verification: { state: 'unknown', summary: '检查结果还不完整。', checks: [] },
    confirmation: { state: 'pending' },
    deliveryState: 'sent',
    createdAt: '2026-10-28T03:10:00.000Z',
  },
  confirmation: { state: 'pending' },
  verification: { state: 'unknown', summary: '检查结果还不完整。', checks: [] },
  availableActions: ['view', 'open_session', 'confirm', 'continue'],
}

function Frame(props: { width: number; children: React.ReactNode; label: string }): React.ReactElement {
  return (
    <div data-preview={props.label} style={{ width: props.width, height: 780, margin: 16, border: '1px solid #ccc' }}>
      <div style={{ height: '100%' }}>{props.children}</div>
    </div>
  )
}

function Shell(props: { status: string; theme?: 'dark'; children: React.ReactNode; drawer?: React.ReactNode }): React.ReactElement {
  return (
    <section data-boop-home="" data-boop-theme={props.theme === 'dark' ? 'dark' : 'light'} data-boop-advanced="false" style={{ height: '100%' }}>
      <BoopHeader status={props.status} workOpen={Boolean(props.drawer)} settingsOpen={false} onWork={() => undefined} onSettings={() => undefined} />
      <div className="boop-body">
        <div className="boop-chat"><div className="boop-column">{props.children}</div></div>
        {props.drawer}
      </div>
    </section>
  )
}

function Composer(): React.ReactElement {
  return (
    <div data-conversation-content="" data-composer-seat="" style={{ marginTop: 'auto', width: '100%' }}>
      <div data-composer-card="" style={{ minHeight: 64, border: '1px solid var(--boop-border)', background: 'var(--boop-surface)', padding: 12, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <button type="button" className="boop-text-button" aria-label="附件">附件</button>
        <div style={{ flex: 1, minHeight: 40 }} />
        <button type="button" className="boop-primary">发送</button>
      </div>
    </div>
  )
}

export function Gallery(): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', background: '#888' }}>
      <Frame width={1280} label="welcome-light">
        <Shell status="可以聊天，也可以继续已有项目">
          <BoopWelcome message="我是波波。你可以和我聊想法，也可以让我继续推进已有项目。" modelMissing={false} onSetup={() => undefined} />
          <Composer />
        </Shell>
      </Frame>
      <Frame width={1280} label="working-dark">
        <Shell theme="dark" status="正在处理一件工作，聊天仍然可用" drawer={<WorkDrawer tasks={[task, delivered]} onClose={() => undefined} onAction={() => undefined} />}>
          <div className="boop-card" style={{ marginTop: 24 }}>继续 Cellgent 分屏的原开发会话，检查窄屏问题，先不要部署。</div>
          <WorkCard task={task} onAction={() => undefined} />
          <Composer />
        </Shell>
      </Frame>
      <Frame width={390} label="narrow">
        <Shell status="窄屏">
          <BoopWelcome message="先连接一个模型，就可以开始和我聊了。" modelMissing onSetup={() => undefined} />
          <Composer />
        </Shell>
      </Frame>
      <Frame width={1100} label="settings">
        <Shell status="设置" drawer={<SettingsPanel home={{ state: 'ready', mainSessionId: 'hidden', bindingVersion: 1, capabilities: { send: true, readSources: true, delegate: true, stop: true, reasonCodes: [] } }} onClose={() => undefined} onAdvanced={() => undefined} />}>
          <BoopWelcome message="我是波波。你可以和我聊想法，也可以让我继续推进已有项目。" modelMissing={false} onSetup={() => undefined} />
        </Shell>
      </Frame>
    </div>
  )
}

const style = document.createElement('style')
style.textContent = BOOP_HOME_CSS
document.head.appendChild(style)
createRoot(document.getElementById('root')!).render(<Gallery />)
