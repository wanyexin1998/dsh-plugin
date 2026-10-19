# dashi-taskboard 复用审查与接入决策

> 版本：1.1 · 日期：2026-10-16  
> Taskboard：`723c400eec86c454c1ffa56ee1b500746d41e142`，根包 `codex-taskboard 1.1.26`。  
> 目标宿主：DSH `0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。  
> 本文是源码研究与设计修订，不是已完成代码移植、兼容认证或完整安全审计。[S28][S29]

## 01｜结论

**值得复用，采用“选择性源码移植”：以现有看板交互为前端基础，将数据、任务语义和动作接口改接 BOOP。不要把整套 Codex Taskboard 当作 BOOP 的任务执行后端。**

这不是仅借鉴视觉后全部重画，也不是直接运行原仓库再换 Logo。能复用的是真实的 React 组件、过滤/排序与拖拽交互、部分展示逻辑和测试思路；需要适配的是宿主、模型对象和命令边界。工作量性质为中等适配，而非“改几行即可”，尚无运行验证，不能给出可信的固定人天数或复用百分比。

原方案“任务看板完全自研”调整为：**看板前端选择性复用，BOOP 任务控制与记忆内核保持自研。**

## 02｜源码实际是什么

根 README 当前以 Codex Taskboard 为标题，描述本地优先的 HTTP + SQLite 应用，React UI 与 taskctl CLI 共用 HTTP API。仓库还有 Codex CDP 注入、Tauri 启动器、独立 AI Chat、云端与 Jira 等能力，并不是只导出一个 Kanban React 组件包。[S29][S35][S37]

`integrations/deepseek-harness/` 有实际 DSH 集成，但它的能力是展示嵌入，不是 BOOP 需要的受托任务控制：

1. `index.js` 从 launcher-runtime.json 读取另一个正在运行的 Taskboard 服务 URL。
2. DSH 路由将浏览器请求以 307 重定向到该服务；默认 runtime 文件位置指向 macOS 的 Application Support，环境变量可覆盖。
3. `client.js` 注册侧栏入口，以 iframe 展示服务。
4. 客户端扫描全 DOM 的 CSS 类后缀 `_centerCol` 获取尺寸，用 fixed 面板覆盖对应区域；没有使用 DSH `main` keyed slot。

因此，源码“有 DSH 目录”不能被写成“已在 Web/Desktop rc.2 中原生集成且兼容 BOOP”。[S30][S31]

## 03｜复用范围

| 源码范围 | 决策 | 必要适配 |
|---|---|---|
| BoardColumn.tsx | 优先复用 | 列由 BOOP 三轴状态投影；更换 Task 类型；动作改为受控 command |
| TaskCard.tsx | 裁剪复用 | 保留布局、时间、标签、拖拽；替换 Codex actor、附件 URL、会话菜单 |
| TaskFilterMenu / taskFilters / 排序 | 优先提取 | 字段映射为 BOOP 工作区、受托范围、待决原因 |
| IssueListView | 选择性复用 | 与看板共用 BOOP view model，不能生成另一份任务状态 |
| TaskDetail.tsx | 拆分后复用 | 移除直接 API 依赖；保留详情布局，改为目标/执行/验收/证据 |
| taskConversations / agentSessions | 参考交互，不原样接入 | 替换 Codex thread 为带 scope 的 DSH sessionRef 与原生导航 |
| 乐观版本冲突处理 | 借鉴 | 写入统一使用 BOOP task version；冲突显示并重读，不静默覆盖 |
| App.tsx / api.ts | 不整段移植 | 自己装配 BoopTaskBoard，依赖 BOOP 查询/命令服务 |
| server/database.mjs | 不作为第二任务库 | BOOP task/action/approval 为唯一权威；仅参考通用约束 |
| Codex AI Chat / composer | 不引入 | 继续复用 DSH 唯一 BOOP 主会话 |
| CDP injector / Tauri launcher | 不引入 | 不开调试端口、不绕过 CSP、不启动另一桌面壳 |
| Cloudflare/Jira/独立自动化 | 第一版不引入 | 不增加云服务、账户或旁路调度 |
| Gantt / 复杂项目仪表盘 | 暂不引入 | 用户任务量有限，先聚焦看板与列表 |

BoardColumn 已将更新、完成、拖拽、打开会话暴露为回调，利于适配。但 TaskCard 会引用原附件解析和 Codex actor，TaskDetail 直接导入原 API、评论、附件和线程类型，因此不是“可无依赖直接拷贝”的纯组件。[S32][S33][S34]

## 04｜唯一推荐的数据链路

```text
任务看板 UI（提取并适配上游组件）
        │ 查询／用户动作意图
        ▼
BOOP Board Adapter（展示模型与动作映射）
        │
        ▼
BOOP Task Service（版本、范围、审批、验收校验）
        │
        ├── BOOP task/action/approval 唯一账本
        └── DSH adapter → 已授权的原 Session
```

不运行原 Taskboard 服务，不并行维护 `.data/taskboard.sqlite`，也不通过双写同步两个 `done` 字段。看板上的 `displayColumn` 是派生值，任务控制服务才决定真实状态。读取模型可缓存，但缓存带版本与状态新鲜度，不能被当作独立权威。

保留任务卡现有回调形态，将其接到 `requestPause`、`requestResume`、`requestPriorityChange`、`openSession` 等语义命令。这里是 BOOP 拟开发契约，不是已有上游 API。

## 05｜状态与操作必须重新映射

上游状态包含 backlog、todo、in_progress、in_review、blocked、done、canceled。它已有“先进入 in_review，再等用户明确接受”的 Skill 指导，适合借鉴，不应将其描述为完全没有验收意识。但 Skill 指导本身不等于 BOOP 的服务端授权与证据约束。[S36][S37]

BOOP 继续采用任务生命周期、执行状态、验收状态三轴；看板可按已确认的四组呈现：

| 展示组 | 典型情况 | 不能混淆的情况 |
|---|---|---|
| 待开始 | 已明确受托，尚未派发 | 仅讨论过的想法不自动入队 |
| 进行中 | 已派发、执行中、自动核查中 | 已提交不等于目标 Agent 已开始 |
| 待我处理 | 审批、恢复、歧义、人工验收 | 不能用一个 in_review 掩盖不同决策 |
| 已结束 | 验收通过、用户结束、取消 | 需保留结束原因，不全部显示绿色“成功” |

同列拖动只改变优先级/排序；跨列拖动如果保留，只产生动作意图，由服务端决定是否允许。第一版默认不允许拖入“已结束”就改验收结果。恢复要明确确认，审批以精确对象绑定，工作区或 Session 归档不隐藏在卡片拖拽里。

网页请求中的 actor 字段不是登录凭据，不能作为“用户亲自批准”的证据。全部动作经宿主已鉴权连接，重新核查 owner/scope/taskVersion/policyEpoch；按钮与 BOOP 工具必须经过同一服务端规则。

## 06｜rc.2 兼容性检查

| 已发现差异 | 影响 | 处理 |
|---|---|---|
| Taskboard 使用 React 19.x；DSH rc.2 Conversation 声明 React 18.x | 不能假定组件和新依赖无变化可运行 | 迁移组件按宿主版本编译；不把第二份 React 挂进同一组件树 |
| 上游 root 为 Vite 独立应用 | 不等于 DSH bundle 输出 | 按 BOOP 构建与 dsh.client 装配，React 使用宿主依赖 |
| DSH 集成通过 iframe + DOM 类后缀定位 | 上游布局变化、分屏与窗口 chrome 可能错位 | 改用 rc.2 root `main` keyed slot，注册 `boop.tasks` |
| Taskboard 使用独立服务地址与 runtime 文件 | 用户要额外维护进程和路径 | 删除这条依赖，接 BOOP Host API |
| 上游 task/thread/project 模型 | 不等于 BOOP 委托与 DSH scope | 提供显式 ViewModel Adapter；拒绝仅按显示名关联 |
| 原独立应用样式 | 可能污染 DSH 全局 | `.boop-taskboard` 局部作用域、token adapter、图标与 portal 归属 |

依赖差异由包文件确认；组件是否涉及 React 19 专属 API 仍需提取后编译与回归，不能单凭大版本不同断言不兼容。DSH rc.2 已有 `main` key 和 `layout.selectPanel`，不是需要我们再造的能力。[S29][S39][S05]

## 07｜安全、许可和依赖

根 LICENSE 为 Apache-2.0，可以在遵守条件的前提下修改并分发。需要保留许可和适用归属说明、标明改动，若上游分发包含适用 NOTICE 还需保留。第三方依赖/图片/品牌资源单独清点；本次不是完整法律审查。[S38][S42]

上游 README 明确说明独立本地服务默认绑定 `0.0.0.0`，局域网模式没有账户鉴权。它服务于可信网络场景，不能原样成为 BOOP 的高权限动作入口。实际是否能被网络访问还取决于网络/防火墙，本报告不声称发现了可远程利用的漏洞。[S37]

不继承 Codex 集成里的 CDP/CSP 绕过；也不把独立 AI Chat 或任意 shell 代理作为控制 BOOP 的旁路。

依赖包包含 dhtmlx-gantt `^10.0.0`。官方文档说明 v10+ Community 已改为 MIT，旧 GPL 印象不能套用到这条依赖上；不过最终发版仍应以实际锁定版本核查。甘特图第一版不引入，理由是范围控制，而不是未经核实的 GPL 障碍。[S29][S43]

## 08｜提取后的验证门槛

| 编号 | 必须验证 | 通过标准 |
|---|---|---|
| TB01 | Web/Desktop rc.2 安装与卸载 | 只新增 BOOP 看板，原侧栏/聊天正常 |
| TB02 | React 与 bundle | 单宿主 React，无 hook 错误或重复运行时 |
| TB03 | 宿主 Panel、窗口与分屏 | 不扫描 DOM、不卡住 Mac/Win 窗口控件、返回保持原 Session |
| TB04 | 任务状态映射 | 执行结束≠验收通过，结束/取消/豁免可区分 |
| TB05 | 拖拽与按钮动作 | 不绕过授权，跨列拒绝可解释，同列排序不启动 Agent |
| TB06 | 冲突与重连 | 版本过旧时拒绝，刷新后不丢最新状态或重复命令 |
| TB07 | 安全渲染与附件 | 复用宿主已授权文件能力，外链/Markdown 不执行任意内容 |
| TB08 | CSS、明暗与无障碍 | 不污染普通 DSH；键盘操作和非拖拽替代路径可用 |
| TB09 | 停用与权限收紧 | UI 不可用动作禁用，服务端同样拒绝，不能借 CLI 绕行 |
| TB10 | 发布与归属 | 锁定来源 SHA，保留变更标记、许可和依赖清单 |

本轮核查了上游测试中的版本冲突用例，但没有执行第三方测试，也没有完成上述兼容回归。[S40]

## 09｜对五册方案的影响

第 01 册：功能结构不变，一个主聊天和一个轻量任务看板。

第 02 册：DSH Loop、模型路径、196k 配置前提不变。

第 03 册：增加看板适配层及第三方源码边界，不增加第二数据库和独立控制服务。

第 04 册：看板由完全自研改为选择性提取组件，保留任务三轴语义、审批与原生导航。

第 05 册：按用户 Cellgent 参考重写视觉规则，KV 采用细腻 3D 角色，UI/小图标采用同形简化版；不使用上游 Codex 标识。

## 10｜仍未完成的工作

尚未编译提取组件，尚未在本地 DSH Web/Desktop 安装，未对全部上游源文件做安全审计，未测试真实模型和 IM 渠道。本轮交付是复用决策、修订规格和阅读材料，不是已改好的 Taskboard 插件。
