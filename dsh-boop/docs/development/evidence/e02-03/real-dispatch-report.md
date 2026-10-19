# E02-03 · 真实派发与对账报告（真实宿主 Agent + 真实 Qwen 模型）

> 运行时间：2026-10-17T19:17:36Z – 19:18:01Z（本地 2026-10-18 03:17 起）
> 执行：`tests/host/e02-03-real-dispatch.test.mjs`（本报告同目录 JSON 由该测试真实运行写出）
> 结论：**PASS** — 真实 Host + 真实 Agent + 真实模型完成 BOOP 代理命令派发与全链路对账，无 mock、无伪造。

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 真实模型路由（hand-declared `llm-pi-ai` gateway） | **可用**（`qwen-local` / `qwen3.8-27b`，assistant 消息 source.provider 实测为 `qwen-local`） |
| 真实 Session + 真实 Agent（`session/create` → `SessionController.resolveAgent`） | **PASS** |
| BOOP 代理命令派发（`prepareProxyCommand` + `DshAdapter.enqueueProxy` → `Agent.followup`） | **PASS**，accepted=true，messageId=`msg_act_<uuid>` / actionId=`act_<uuid>` |
| durable 日志 provenance：`source.kind === "boop-command"`（≠ user） | **PASS**（`user/message` seq 8） |
| inbox 认领对账 | **PASS**（runtime `agent/inbox/claimed` 捕获 1 次 + durable `agent/inbox/spliced` 插入/清空对） |
| 真实模型回复完成 | **PASS**：`BOOP-OK`，`turn/end reason=completed`，单 turn 约 6.7–8.1s（4 次实测） |
| 无重复执行 | **PASS**（同一 messageId 恰好 1 次 claim、1 条 durable `user/message`、inbox 消费为空） |
| 重启边界（durable 记录存活、不自动重放） | **PASS**（新进程 gate 未收养任何旧命令；恢复 Agent 后无 turn/start、无新 claim） |
| 真实测试稳定性 | **4 次连续 5/5 PASS**（30–48s/次，含 profile 安装与两次 boot） |
| E00-02 回归 | **8/8 PASS** |
| `node build.mjs` | **PASS**（全部 14 个产物构建成功） |

原始 JSON：[real-dispatch-2026-10-17T19-17-36-072Z.json](real-dispatch-2026-10-17T19-17-36-072Z.json)

## 1. 环境（隔离，绝不触碰用户 ~/.dsh）

| 项 | 值 |
|---|---|
| 宿主 | DSH Desktop `0.2.1-rc.2`（payload `.work/test-host/payload-0.2.1/dsh`，pinned commit `332895e0f7c9d4dbfb29729f5eb367fa263ff986`） |
| Node / OS | v24.18.0 · win32 x64 |
| DSH_HOME | `.work/test-runs/e02-03-real-<epoch>/dsh-home`（每次新建；profile `boop-poc-real`） |
| 项目 cwd | `.work/test-runs/e02-03-real-<epoch>/project` |
| 模型服务 | vLLM `http://172.26.0.49:8000/v1`，served id `qwen3.8-27b`（另有 `Qwen3.8-27B`、`qwen3.8` 别名），`max_model_len=196608`，root `./Qwen3.8-27B-AWQ-INT4`，4bit |
| 凭证 | 服务**无凭证**；pi-ai 的 OpenAI-compatible 通道要求 key 字段存在，故用 env `BOOP_QWEN_KEY` 占位（值为固定占位串，无任何真实密钥；见 §3 已知限制） |

## 2. 最终可用模型路由配置（脱敏，可直接复现）

测试 profile 的 `cordis.patch.yml`（仅此隔离 profile；行 id 以 `dsh-base/cordis.patch.yml` 实际为准）：

```yaml
- id: boop-api
  config:
    pocEnabled: true            # PoC 端点仅在该隔离 profile 开启；插件默认 false

- id: llm-pi-ai
  config:
    providers:
      qwen-local:
        displayName: Qwen local (vLLM)
        api: openai-completions
        baseURL: http://172.26.0.49:8000/v1
        apiKeyEnv: BOOP_QWEN_KEY        # 引用占位 env，不含真实密钥
        models:
          - id: qwen3.8-27b
            name: Qwen 3.8 27B (self-hosted vLLM)
            contextWindow: 196608

- id: agent-default-model
  config:
    provider: qwen-local
    model: qwen3.8-27b
```

迭代记录（本机实测）：
- `llm-pi-ai` 行在 base patch 中已存在且初始为 dormant（`providers` 空 → 不注册路由）；用行 `config.providers` 声明即可，无需改 settings 文档。hand-declared route 必须同时给 `api`、`baseURL`、非空 `models`（README «Failures and recovery»），否则启动即拒。
- **keyless 不等于无 key 字段**：README «Known Limitations»（无凭证路由）明确记录 OpenAI-compatible 实现仍要求 API key 或 `Authorization` header，否则请求侧失败。用 `apiKeyEnv` 引用一个进程内占位 env 即可，无需真实密钥。
- `agent-default-model` 行 config 覆写为 `{provider, model}` 后，`session/create` 新建 Agent 的 `agentOptions()` 即取该选择（实测 assistant `source.provider=qwen-local`）。
- 模型服务无需 `modelOverrides`/`compat`；`contextWindow: 196608` 与服务端 `max_model_len` 一致（E05-00 已实测该整数）。

## 3. 派发路径（为什么不用 `session/prompt`）

- `session/prompt` 的 `SessionPromptRequest` 只携带 requestId/sessionId/mode/content，其 relevance 类型硬编码人类来源，**无法携带 BOOP proxy source**；用它派发会把代理命令伪装成人类消息（G03 禁止）。
- 因此派发走 `ctx.boop.prepareProxyCommand(...)`（host 铸造 actionId/messageId/payloadHash，写入本进程 messageId 登记表与 gate）+ `new DshAdapter({ctx}).enqueueProxy(...)` → `Agent.followup(message)`（`next-turn` 变道 + wake）。测试用 PoC 端点 `boop/pocDispatch` 触发同一条真实代码路径（`pocEnabled` 才可用）。
- 实测派发本身耗时 **74ms**（2026-10-17T19:18:01Z 运行），不含模型 turn。

## 4. 对账证据（durable 日志 + runtime 事件）

本次运行（session `session-57f646f1-378e-4465-8845-065acf9d6734`，durable head seq 16）：

| 对账键 | 值 | 来源 |
|---|---|---|
| dispatch.messageId | `msg_act_cb764f54-b168-4ce9-a1c1-6842bcd4c94f` | `boop/pocDispatch` 返回（host 铸造） |
| dispatch.actionId | `act_cb764f54-b168-4ce9-a1c1-6842bcd4c94f` | 同上 |
| durable `agent/inbox/spliced` seq 3 | target=next-turn，inserted=[该 messageId]，removedCount=0 | 持久 inbox 接收证据 |
| runtime `agent/inbox/claimed` | messageId 相同、source.kind=`boop-command`、actionId 相同、turn=1，仅 1 次 | `boop/pocClaimFeed`（实时捕获） |
| durable `agent/inbox/spliced` seq 5 | target=next-turn，inserted=[]，removedCount=1 | **认领的 durable 边界**（claim 清空 inbox） |
| durable `user/message` seq 8 | id=该 messageId，source.kind=`boop-command`，source.actionId 相同 | 持久 provenance（≠ user） |
| assistant/message seq 14 | provider=`qwen-local`，model=`qwen3.8-27b`，text="\n\nBOOP-OK" | 真实模型回复 |
| turn/end seq 16 | turn=1，reason=`completed` | 正常结束（非 error/abort） |
| inbox projection（turn 后） | nextTurn=[], nextStep=[] | 已消费、不重复 |

完整事件序列（seq:type）：`0:permission/preset, 1:sandbox/mode, 2:approval/policy, 3:agent/inbox/spliced, 4:turn/start, 5:agent/inbox/spliced, 6:step/start, 7:system/message, 8:user/message, 9-11:user/message(runtime-context/skill-catalog/time-context), 12:request/header, 13:request/context, 14:assistant/message, 15:step/end, 16:turn/end`。

### rc.2.1 事实修正：`agent/inbox/claimed` 不是 durable 事件

`dsh-agent-loop` 的 `claim()` 通过 `dispatch.emit("agent/inbox/claimed", …)` 发出该信号（`Agent` 构造时 `this.dispatch = agentEvents(loopCtx, this)`），**从未 `session.append`**，因此它不出现在 Session 日志里；durable 的“已认领”边界是紧随其后的 **清空型 `agent/inbox/spliced`** 事件，之后消息才以 `user/message` 落盘。本报告据此同时给出两条证据：runtime claim（`pocClaimFeed`，根 ctx 监听 `agent/inbox/claimed`，payload 含 `{agent,message,turn}`）与 durable 边界（splice 对）。E00-02 注释里“`agent/inbox/claimed` reports each claimed message with its turn”容易被读成 durable 事件，建议 STATUS/后续文档按此修正措辞。

## 5. 真实验证发现并修复的缺陷（`src/host/transport/dsh-adapter.ts`，最小修复）

真实宿主第一次运行即暴露 3 个只在真实部署才可见的缺陷（E00-02 的合成 inbox 路径不经过该适配器，因此未暴露）：

1. **`@deepseek-ai/dsh-llm` 静态导入使整个 `boop-api` 行加载失败**：该包未在本插件 `peerDependencies` 声明，linked/pnpm 安装的 profile 无法从插件位置解析 → `boop-api (dsh-boop/api): failed to import: ERR_MODULE_NOT_FOUND`，**所有** `boop/*` 端点 404。修复：不再依赖 host 包，按 host helper 的运行时语义本地构造消息（`structuredClone` + `Object.freeze`，`role:'user'`）。已实测修复后 api 行正常挂载。
2. **派发回执 id 与 durable 消息 id 分叉**：`createUserMessage({content, source})` 会用新 UUID 覆盖传入 id，导致回执 `messageId` 永远不出现在日志中、无法按 id 对账（正是 E02-03 的核心要求）。修复：消息 id 取 host 铸造的 `envelope.messageId`（与 `pocSeedInbox` 的 seed 语义一致），实测 durable `user/message`/claimed id 与回执一致。
3. **`SessionController.resolveAgent()` 返回结果联合而不是 Agent**：rc.2.1 中它应答 `{agent} | {error}`（见 `dsh-api-session-controller/lib/index.js`），旧适配器把包装对象当 Agent，`target.followup is not a function` → 派发失败却可能被误判。修复：解包 `agent`，`error` 视为不可解析；新增 `inspectAgent()` 供 PoC 端点回报错误文本/agentId/cwd。

## 6. 复现命令

```powershell
$env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"
$env:BOOP_QWEN_MODEL="qwen3.8-27b"
$env:BOOP_QWEN_KEY="boop-local-placeholder-not-a-secret"   # 占位；服务无凭证
$env:BOOP_EVIDENCE_DIR="docs/development/evidence/e02-03"  # 可选：写出本目录 JSON
node build.mjs
node --test --test-force-exit tests/host/e02-03-real-dispatch.test.mjs
node --test --test-force-exit tests/host/e00-02-proxy-gate.test.mjs   # 回归
```

未设置 `BOOP_QWEN_BASE_URL`/`BOOP_QWEN_MODEL` 时：**5 个测试全部 SKIP 并在 skip 原因中说明**（绝不 fake PASS）；实测该路径 0 pass / 5 skipped / 274ms。

实测结果（4 次连续真实运行）：
- 5/5 PASS · turn 8034ms / 7362ms / 6889ms / 7309ms，每次 head seq 16，回复均为 `BOOP-OK`，turn/end 均 `completed`；
- E00-02 回归 8/8 PASS；`node build.mjs` 14 产物全部成功。

## 7. 未覆盖 / NOT_RUN（如实记录，不伪造）

1. **同一 messageId 的跨 turn/跨进程重放去重**：host inbox 只保证“同一条目 pending 期间不重复插入”；消息被 claim 清空后，再插入同 id 会再次执行。BOOP 的幂等键是 actionId 在 dispatch 层的登记与对账（`Dispatcher` 单测已覆盖），跨运行恢复/去重属 E03/E04 组合，本 profile 未接线 → NOT_RUN。
2. **`agent/pre-step` 真实运行时门控**：`RecoveryGate.decide` 已实现且单测/E00-02 覆盖“阻断判定”，但把它接到 `agent/pre-step` 的运行时接线尚未组合；本文件验证的是**重启后的 durable 事实**（新进程不收养旧命令、不自动执行、provenance 存活），不声称运行时门控已生效 → NOT_RUN。
3. **UI 侧代理标签**：本测试走 `/api` RPC 面，未渲染浏览器 UI；proxy source 的展示属客户端 E04 证据。
4. 模型服务为共享 GPU；本报告只取单次短 turn（约 7s），未做并发/长 prompt 压测。

## 8. 建议 STATUS 措辞（供 Lead，不直接改 STATUS.md）

> **E02-03 真实派发与对账：PASS。** 真实宿主 DSH 0.2.1-rc.2 中，真实 Session 的 Agent 通过 hand-declared `llm-pi-ai` 路由（`qwen-local` / `qwen3.8-27b`，vLLM 196608 ctx，无真实凭证）完成一次 BOOP 代理命令派发：`prepareProxyCommand` + `Agent.followup` 派发 accepted，durable `user/message` 的 `source.kind="boop-command"` 与派发 messageId/actionId 一致，runtime `agent/inbox/claimed` 恰好 1 次、durable inbox splice 完成认领清空，真实模型回复 `BOOP-OK`、`turn/end=completed`（≈7s）；重启后 durable 记录存活、无自动重放。修复 3 个真实缺陷（dsh-llm 导入致 api 行加载失败、回执 id 与 durable id 分叉、resolveAgent 结果联合未解包）。`agent/inbox/claimed` 经核实非 durable 事件（仅 dispatch bus），对账以 splice 对 + `user/message` 为准。存续限制：同一 messageId 跨 turn 重放去重、`agent/pre-step` 运行时门控接线仍 NOT_RUN。
