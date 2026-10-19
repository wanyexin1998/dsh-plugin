# E05-00 · 自有 Qwen 真实金标报告（G02）

> 运行时间：2026-10-17T19:24:56.941Z（耗时 8.5s）
> 由 `tools/qwen-gold.mjs` 生成；配置脱敏，不包含任何密钥。

## 0. 结论

- 有效上下文整数（服务端报告）：**196608** tokens（声明标签：196k；模型名不参与推断）
- 服务端：`http://172.26.0.49:8000/v1`；模型 `qwen3.8-27b`；root `./Qwen3.8-27B-AWQ-INT4`；量化 `4bit`
- 凭证：**无凭证**（配置显式声明 none）
- 外部回退：**禁止**

| 能力 | 结果 | 证据 |
|---|---|---|
| basic-response | **PASS** | answered in 458ms; reasoning separated from final text |
| tool-call | **PASS** | echo proposed in 1091ms; BOOP would execute it |
| unicode-arguments | **PASS** | Chinese + Unicode arguments round-tripped losslessly |
| multi-step | **PASS** | two-step chain completed; BOOP executed the side-effect-free tool |
| strict-json | **PASS** | schema-constrained JSON parsed and validated; tiny-budget finish=length parsed=false guard=ok |
| cancel | **PASS** | client aborted after 3 chunks (first in 186ms); server-side release is not claimed |
| context-ladder | **PASS** | 8k/32k/64k requests accepted with observed prompt tokens 8288/33116/66219 |
| token-accounting | **PASS** | usage present and consistent (ratio 1.095 vs 1.036 per target-token) |

## 1. 能力映射（由熔断规则决定，不是打分）

| 能力 | 允许 |
|---|---|
| 只读聊天 | ✅ |
| 记忆提取 job | ✅ |
| 自主派发 | ✅ |
| 历史批量学习 | ✅ |

## 2. 上下文与边界观测

- 分长度实测 prompt tokens：8288 / 33116 / 66219（目标 8k / 32k / 64k）
- 接近上限请求：目标 ~180000 tokens → HTTP 200，实测 prompt_tokens=186219，finish=stop，耗时 1.3s
- 超上限请求：目标 ~210000 tokens → HTTP 400；service rejected the over-limit request: MODEL_BAD_REQUEST 400: This model's maximum context length is 196608 tokens. However, you requested 8 output tokens and your prompt contains at least 196601 input tokens, for a total of at least 196609 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=196601)
- 预算规则：`input + outputReserve + safetyMargin <= effectiveContextLimit`（`clampRequest`）；196k 标签不作为预算。

## 3. 复现命令

```powershell
$env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"
$env:BOOP_QWEN_MODEL="qwen3.8-27b"
node tools/qwen-gold.mjs
```

原始 JSON：[qwen-gold-2026-10-17T19-24-56-941Z.json](qwen-gold-2026-10-17T19-24-56-941Z.json)

