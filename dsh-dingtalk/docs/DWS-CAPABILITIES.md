# Web DWS 能力扩展

版本：`0.2.0-dev.2`。开发与安装源码统一位于 `wanyexin1998/dsh-plugin/dsh-dingtalk`。本次扩展 Web 入口；钉钉 IM 的身份统一与开放策略保持第一阶段边界。

## 使用

安装后在设置中连接钉钉，然后直接用自然语言请求，例如“查看我的待办”“搜索项目文档”“创建明天下午的会议”“读取这张多维表格”。无需填写 JSON 或逐项启用技能。新会话可发现 1 个通用技能与 33 个产品技能；产品技能按需读取目录与参数，不把全部命令正文塞入上下文。

查询返回普通对话结果。默认情况下，写入、删除、文件操作和后台执行通过 DSH 原生确认；拒绝确认不会执行。授权仍在回复末尾的原位组件中处理。

## 免确认白名单

在 `@wanyexin1998/dsh-dingtalk/web` 的现有 `config` 内添加 `confirmationAllowlist`，保留原有 `mode` 等配置。它只影响机器人和 Web 会话里的 `dingtalk_call`。`true` 跳过该命令的 Host 确认，包含发消息、删除、改权限、文件和后台操作。缺省或 `false` 使用原审批设置。

```yaml
confirmationAllowlist:
  'doc create': true # 创建在线文档
  'chat message send': true # 发送消息
  'todo task delete': true # 删除待办
  'drive permission add': true # 添加协作成员权限
```

通配符、未知命令和非布尔值会使 Host 配置报错。钉钉账号、企业身份、资源权限、命令参数和本地工作区限制不变；上游标记不可用或由 Host 管理的入口仍不可执行。机器人原生 `send_file` 独立于 DWS，仍需单次审批。免确认调用保留工具调用和结果记录。

在源码目录生成当前锁定目录的完整 YAML 清单。每条都有中文注释，所有命令均为未注释的 `true`。复制整份清单即可让当前版本下可执行的 DWS 命令免确认。升级 DWS 后重新生成清单，以覆盖新命令并移除已删除的命令。

```sh
cd dsh-dingtalk
pnpm run build
pnpm --silent run dws:confirmation-template > dws-confirmation.yaml
```

## 覆盖与限制

目录来自固定 DWS `1.0.66`，commit `f215043e676d6889e1ddce3464828d8b1ec40c31`，共 33 产品、1540 命令入口。这个数量包含快捷命令、组合操作和底层命令，不等于 1540 项独立业务功能。

- 官方标为不可用的 31 个入口只展示说明，不能由插件解锁。
- 1476 个入口进入通用执行通道；其余 33 个凭据管理、Webhook Token、另起 Agent、内部审计等控制面入口不交给模型执行，目录标记 `host_managed`。
- 其余命令经官方 Schema 校验后调用官方 CLI；是否能访问具体资源仍由企业开通状态、应用权限、账号权限与参数决定。
- 文件限会话工作区；禁止私有凭据目录、常见敏感目录、路径逃逸、符号链接及隐式 `@file` 读取。大数据优先使用官方提供的 `*-file` 参数。Windows 单次命令行超过保守长度上限时拒绝执行，不截断内容。
- 前台调用上限 120 秒。长期任务使用 `background=true`，最长 6 小时；最多 4 个活动任务，保留最多 32 个任务、每任务最近 100 条事件，每次读取最多 10 条。任务只允许所属会话查看/停止，断开连接或 Host 退出会停止任务，不跨重启恢复。
- 通用写入不自动重试。超时、输出无法解析等不确定结果返回 `outcome_unknown`；先查询实际状态，避免重复发送或创建。
- 创建多维表时，成功回执中的空错误对象不表示失败；插件使用本次回执的 `baseId` 返回可打开的新表链接。缺少有效 ID 时不返回链接，也不重复创建。

## 开发契约

仍使用 `dingtalk_call`，新增：

| operationId    | args                                          | 用途                         |
| -------------- | --------------------------------------------- | ---------------------------- |
| `dws.catalog`  | `product?`, `query?`, `offset?`, `limit?`     | 产品总览、分页搜索           |
| `dws.describe` | `command`                                     | 精确参数、约束、风险与可用性 |
| `dws.execute`  | `command`, `parameters`, `background?`        | 官方命令执行                 |
| `dws.jobs`     | `action: list/read/stop`, `jobId?`, `cursor?` | 当前会话后台任务             |

原 `identity.getSelf`、`calendar.listEvents`、`docs.search` 保留兼容。模型不能传 shell、任意 argv、账号选择或确认布尔值。实际会话 ID、工作目录、原生确认回调由 Host 注入。每次业务执行前在线核对固定绑定身份。CLI 以 `shell=false` 启动；列表编码依据官方 Cobra help，JSON 参数按 Schema 转换；业务 `fields`/`timeout` 与全局选项区分。

目录生成：`node enhancements/scripts/generate-catalog.mjs <锁定二进制路径>`。生成前校验二进制 SHA256，直接解码 UTF-8，并采集数组参数的真实 CLI 编码。更新 CLI 必须同时重新生成目录和执行回归。打包包含目录、技能与官方 Apache-2.0 许可证/NOTICE。

## 验收范围

自动化覆盖全部目录的分页发现、参数描述与公开结果投影，命令/参数注入拒绝、写入确认、身份不一致、文件越界、后台任务隔离和取消、不确定写入不重试。固定官方二进制通过合成 OAuth/MCP 端点验证通用查询（含中文与列表参数）和待办创建。

这不是对全部业务接口的真实企业验收。真实企业的资源权限、消息实际送达、不同产品写入结果及长期订阅需按实际账号使用验证；测试不向真实联系人发送消息、不创建真实业务数据。原三项只读阶段的独立复核结论不能直接覆盖新增执行能力。
