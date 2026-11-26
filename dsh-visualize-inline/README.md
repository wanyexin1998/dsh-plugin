# DSH Visualize Inline

让 Agent 在原生 Markdown 正文中用指标、进度和图表表达准确数据。插件不调用绘图工具、不生成文件、不访问网络，也不修改 DSH 核心或会话格式。

## 支持范围

- DSH：`0.2.3-alpha.2`（依赖该版本提供的 `conversation.chat.markdown.fence`）。
- 基础组件：`metric`、`progress`、`bar`、`horizontal-bar`、`line`。
- 高级组件：`donut`、`funnel`、无环 `flow`、`metric-group`、2–4 系列柱图/折线图，以及仅支持加减乘除的 `calculator`。
- 交互：流式占位与有效预览、悬停/点击/键盘读数、原始数据表或节点列表、响应式布局、深浅主题。
- 降级：最终无效配置显示原生代码块；卸载后历史消息仍是可读的 `visualize` 围栏。

旧版 DSH（包括 `0.2.2-rc.1`）没有所需 Fence Slot，不受支持。不要通过 DOM 注入或修改内核绕过。

## 安装

使用 **0.2.3-alpha.2 的 DSH CLI**，不要用旧版桌面端自带的 0.2.2 CLI：

```powershell
dsh plugin --profile <独立测试-profile> add link:E:/dsh-plugin/dsh-visualize-inline
```

启用 bundle 后重启该实例。包内 `cordis.patch.yml` 只新增 `dsh-visualize-inline` 行；`config.enabled: false` 同时关闭 Host 输出指导和 Client 渲染。`config.v2: false` 仅撤回 V2 模型指导，V1 指导和 V1/V2 历史渲染继续工作。

本仓库的 `integration/dsh` 固定了隔离验收宿主和匹配 Node 运行时，`.runtime/` 保存隔离 profile、假模型及验收截图。假模型只监听 `127.0.0.1`，不需要真实 API 密钥。

## Agent 输出示例

````markdown
11 月现金流较 10 月下降明显。

```visualize
{"version":1,"type":"chart","chart":"bar","title":"月度现金流","unit":"万元","data":[{"label":"9月","value":730},{"label":"10月","value":950},{"label":"11月","value":680}]}
```

建议进一步排查核心渠道。
````

协议为严格判别联合：拒绝未知字段、重复 JSON key、不安全整数、超限数据、原型污染键和无效 Unicode。每块最大 32 KiB，每图最多 120 项；保留输入顺序，不聚合、不补零、不插值。折线遇 `null` 断开，柱图和条图明确提示无数据。

## V2 声明式 UI（P0 + P1）

`version: 2, type: "ui"` 支持递归组件树，V1 输出保持原语义。布局与内容节点包括 `box`、`row`、`column`、`grid`、`divider`、`spacer`、`text`、`title` 和白名单 `icon`；V1 的指标、进度和图表可以直接作为子节点。受控 `svg` 仅接受数值化 line/polyline/rect/circle/text 图元，不解析原始 SVG/path。

局部交互使用 boolean 状态和 Checkbox，派生字段支持 `ref`、`countTrue`、`concat`。状态只存在于单围栏，生成中控件只读，刷新或重挂后恢复初值，不写回会话、文件或业务系统。

```json
{"version":2,"type":"ui","state":{"done":{"type":"boolean","initial":false}},"root":{"type":"box","variant":"card","children":[{"type":"text","text":{"op":"concat","args":[{"op":"countTrue","args":[{"op":"ref","key":"done"}]}," / 1 已完成"]}},{"type":"checkbox","label":"完成验收","bind":"done"}]}}
```

P1 增加 number/enum 状态、Slider、Select、Reset，以及两个数值参数的 `add/sub/mul/div` 和 `round`。数值状态严格校验范围与步进；枚举最多 12 项；Select 选项来自状态声明；Reset 只重置当前围栏。除零或溢出仅让相关派生值显示“无法计算”，其他控件继续工作。

任务清单、双列对比、架构图和参数测算的完整可运行 fixture 位于 `integration/v2-fixtures.mjs`。V2 限制为 80 节点、深度 8、每容器 20 个子节点、20 个状态、120 个 SVG 图元和 360 个累计图表数据点；表达式和文本也采用独立上限。任意表达式、条件渲染、循环、跨围栏状态和持久化表单仍不开放。

## 开发

```sh
npm install
npm run check
npm pack
```

客户端产物使用宿主 React，运行时不捆绑第二套 React/Cordis。`lib/` 为构建产物，请勿直接编辑。

## 已知限制

- Flow V1 仅支持最多 24 节点、48 条边的无环流程，不支持任意坐标或 Mermaid；环图和漏斗最多 12 项。
- 多系列仅支持 2–4 个系列的柱图和折线图；指标组最多 6 项、三列自适应。
- Calculator 不接收表达式或代码，仅支持 2–6 个数值的加减乘除，减法和除法固定两个操作数。
- 不支持导出、持久交互状态、任意 HTML 应用或编辑画布。
- `streaming` 表示 Markdown 文档状态，不是单围栏闭合或中断原因。
- 大量数据点会提供横向或纵向滚动；精确记录请使用“查看数据”。
- 本仓库只声明已核对版本；真实模型选择效果与性能需要按固定样本另行验收。
