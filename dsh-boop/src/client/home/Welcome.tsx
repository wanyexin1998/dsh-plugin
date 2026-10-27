import React from 'react'

export function BoopWelcome(props: { message: string; modelMissing: boolean; onSetup: () => void }): React.ReactElement {
  return (
    <div className="boop-welcome">
      <h1>{props.modelMissing ? '先连接一个模型' : '我是波波'}</h1>
      <p>{props.message}</p>
      {props.modelMissing ? (
        <div className="boop-actions">
          <button type="button" className="boop-primary" onClick={props.onSetup}>查看连接说明</button>
        </div>
      ) : (
        <div className="boop-suggestions">
          <span className="boop-pill">聊聊一个想法</span>
          <span className="boop-pill">继续已有项目</span>
          <span className="boop-pill">看看正在做的事</span>
        </div>
      )}
    </div>
  )
}
