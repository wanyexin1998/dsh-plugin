import React from 'react'

export function ComposerState(props: {
  connection: string
  modelMissing: boolean
  notice: string | null
  onRetry: () => void
  onSetup: () => void
}): React.ReactElement | null {
  if (props.connection === 'disconnected') {
    return (
      <div className="boop-banner" role="status">
        连接断开，恢复后会重新同步进展。
        <button type="button" className="boop-text-button" onClick={props.onRetry}>重试连接</button>
      </div>
    )
  }
  if (props.modelMissing) {
    return (
      <div className="boop-banner" role="status">
        先连接一个模型，就可以开始和我聊了。请从仍然可见的 DSH 设置入口打开模型页。
        <button type="button" className="boop-text-button" onClick={props.onSetup}>查看连接说明</button>
      </div>
    )
  }
  if (!props.notice) return null
  return <div className="boop-banner" role="status">{props.notice}</div>
}
