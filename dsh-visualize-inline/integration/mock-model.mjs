import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { v2Markdown, p1Markdown } from './v2-fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(root, '.runtime')
fs.mkdirSync(runtime, { recursive: true })

const markdown = `## 月度现金流分析

11 月现金流较 10 月下降明显，但三季度仍保持正向累计。

\`\`\`visualize
{"version":1,"type":"metric","label":"累计现金流","value":2450,"unit":"万元","note":"目标 3000 万元；仅展示已提供的数据"}
\`\`\`

\`\`\`visualize
{"version":1,"type":"progress","label":"年度目标达成率","value":2450,"target":3000,"unit":"万元"}
\`\`\`

### 月度变化

\`\`\`visualize
{"version":1,"type":"chart","chart":"bar","title":"月度现金流","unit":"万元","data":[{"label":"9月","value":730},{"label":"10月","value":950},{"label":"11月","value":680}]}
\`\`\`

11 月环比下降约 **28.4%**。下面的趋势包含一个明确缺失值，折线会在缺失处断开：

\`\`\`visualize
{"version":1,"type":"chart","chart":"line","title":"六个月现金流趋势","unit":"万元","data":[{"label":"6月","value":520},{"label":"7月","value":610},{"label":"8月","value":null},{"label":"9月","value":730},{"label":"10月","value":950},{"label":"11月","value":680}]}
\`\`\`

渠道回款有正有负，条形图使用正确零轴：

\`\`\`visualize
{"version":1,"type":"chart","chart":"horizontal-bar","title":"渠道现金流贡献","unit":"万元","data":[{"label":"核心渠道","value":820},{"label":"合作伙伴","value":-140},{"label":"其他渠道","value":null}]}
\`\`\`

普通 Markdown 表格和代码围栏保持原生渲染：

| 项目 | 数值 |
| --- | ---: |
| 累计现金流 | 2450 万元 |

\`\`\`ts
const untouched = true
\`\`\`

建议进一步排查核心渠道。`

const advancedMarkdown = `## 高级组件验收

先看三个并列指标：

\`\`\`visualize
{"version":1,"type":"metric-group","title":"学习概览","metrics":[{"label":"已学习","value":48,"unit":"小时"},{"label":"剩余","value":72,"unit":"小时"},{"label":"连续学习","value":12,"unit":"天"}]}
\`\`\`

时间分配适合用占比表达：

\`\`\`visualize
{"version":1,"type":"chart","chart":"donut","title":"复习时间分配","unit":"小时","data":[{"label":"数学","value":20},{"label":"英语","value":16},{"label":"专业课","value":12}]}
\`\`\`

学习转化过程如下：

\`\`\`visualize
{"version":1,"type":"chart","chart":"funnel","title":"学习转化","data":[{"label":"课程访问","value":1000},{"label":"加入计划","value":400},{"label":"完成学习","value":160}]}
\`\`\`

实际投入和计划投入必须明确区分：

\`\`\`visualize
{"version":1,"type":"chart","chart":"line","title":"每周学习投入","unit":"小时","series":["实际","计划"],"data":[{"label":"第1周","values":[5,6]},{"label":"第2周","values":[7,6]},{"label":"第3周","values":[null,8]},{"label":"第4周","values":[null,8]}]}
\`\`\`

审批流程包含判断分支：

\`\`\`visualize
{"version":1,"type":"flow","title":"退款审批","nodes":[{"id":"submit","label":"提交申请","kind":"start"},{"id":"review","label":"审核是否通过","kind":"decision"},{"id":"refund","label":"原路退款","kind":"process"},{"id":"negotiate","label":"协商处理","kind":"process"},{"id":"finish","label":"流程完成","kind":"end"}],"edges":[{"from":"submit","to":"review"},{"from":"review","to":"refund","label":"通过"},{"from":"review","to":"negotiate","label":"未通过"},{"from":"refund","to":"finish"},{"from":"negotiate","to":"finish"}]}
\`\`\`

最后进行受控计算：

\`\`\`visualize
{"version":1,"type":"calculator","label":"剩余预算","operation":"subtract","operands":[10000,3650],"unit":"元","note":"仅计算已提供的两个数值"}
\`\`\``

function writeSse(response, payload) {
  response.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    return
  }
  if (request.method !== 'POST' || !request.url?.endsWith('/messages')) {
    response.writeHead(404).end()
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { body += chunk })
  request.on('end', async () => {
    const parsed = JSON.parse(body)
    const isTitle = parsed.system?.includes('Create a concise title')
    fs.writeFileSync(path.join(runtime, isTitle ? 'title-request.json' : 'model-request.json'), JSON.stringify(parsed, null, 2))
    const isAdvanced = parsed.messages?.some((message) => message.role === 'user' && message.content?.some((block) => block.text?.includes('高级组件验收')))
    const isV2 = parsed.messages?.some((message) => message.role === 'user' && message.content?.some((block) => block.text?.includes('V2核心验收')))
    const isP1 = parsed.messages?.some((message) => message.role === 'user' && message.content?.some((block) => block.text?.includes('P1参数验收')))
    const output = isTitle ? (isP1 ? 'P1 参数测算验收' : isV2 ? 'V2 核心体验验收' : isAdvanced ? '高级组件验收' : '可视化现金流验收') : isP1 ? p1Markdown : isV2 ? v2Markdown : isAdvanced ? advancedMarkdown : markdown
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.flushHeaders()
    writeSse(response, {
      type: 'message_start',
      message: {
        id: 'msg_visualize_fixture',
        type: 'message',
        role: 'assistant',
        model: parsed.model ?? 'deepseek-chat',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })
    writeSse(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    const characters = Array.from(output)
    for (let offset = 0; offset < characters.length; offset += 11) {
      if (response.destroyed) return
      const text = characters.slice(offset, offset + 11).join('')
      writeSse(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
      await new Promise((resolve) => setTimeout(resolve, 12))
    }
    writeSse(response, { type: 'content_block_stop', index: 0 })
    writeSse(response, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    writeSse(response, { type: 'message_stop' })
    response.end()
  })
})

server.listen(19424, '127.0.0.1', () => console.log('mock model listening on 127.0.0.1:19424'))
