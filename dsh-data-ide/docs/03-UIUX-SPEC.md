# 03-UIUX-SPEC — UI/UX 规范

> 状态：草案（待 G3）｜上游：01-PRD（IA/用户故事）、02（前端可调契约面）
> 设计原则：**DataGrip 网格 UX 骨架 × dsh 原生设计语言**。权威依据：`docs/web-styling.md`（"只用 `--dsw-alias-*` 语义令牌；禁硬编码色；组件 CSS 禁主题选择器"）。

---

## 1. 信息架构与注册合同

- tab 注册：0.1.7 右栏**页面类型**两段式（06 §12.7.2）——`sidebarRightTabs.register({id:'dsh-data-ide.sql-workbench', kind, title, guide})`，再向 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 两个 keyed seat 注册，`key` 等于定义 `id`；
- **可见性**：右栏是 root 级单容器，不需要容量协商；每个会话各自实例化一份面板（`rightbar.session`）；另提供 "打开 SQL 工作台" 入口（`sidebarRight.openTab(kind)`）兜底；
- 布局：**三面板工作区**（2026-10-19 面板化，对齐 DataGrip 的「对象树在左、编辑区/结果上下分屏」）：`[data-sql-workspace]` 是一个 CSS grid，列为 `左栏px / 8px(sash) / 1fr`，右列再按 `编辑px / 8px(sash) / minmax(132px,1fr)` 分行。
  - **克制圆角 + 间距**：统一 `--sql-radius: 10px`、`--sql-gap: 8px`、外边距 `--sql-space: 8px`；工作区用 `--dsw-specific-sidebar-fill` 做凹陷底，面板是白卡片 + `border-l1` 发丝线。浅色主题里 `bg-base`/`bg-layer-1` 都是 `#fff`，不加这层底和发丝线就看不出「卡片」。
  - **sash 是间距本身**：8px 的空隙就是抓手，默认完全透明（学 `dsh-split` 的 Dockview 皮肤 `--dv-sash-color: transparent` + `theme.gap`），hover/聚焦/拖拽时才显出一条 2px 抓手。pointer 拖动（`setPointerCapture`），方向键 ±16px 微调，双击复位默认值，`aria-valuenow/min/max` 可读。
  - 尺寸约束在 `src/client/split.ts`：左栏 168px ～ 工作区宽-320(编辑区保底)-8；编辑区 96px ～ 工作区高-132(结果区保底)-8。窗口 resize 时重新收窄左栏（dsh 右栏可能只有 ~500px，244px 的树会把编辑器挤到 229px）。
  - 对象树**默认展开**为左栏；「«」收起后变成一条 22px 竖排 rail（「展开对象树」）。对象摘要与刷新移到面板头，树内只留筛选框。
  - **console 标签属于编辑区面板**：`console_1 …` 的 tab 条是编辑区面板自己的 header（DataGrip 里 `console_17 [doris.shcell.com]` 就在编辑器上），不再横跨整个工作台；数据源工具条（选择/配置/测试/新建）仍留在最上方作为全局 chrome。标签条在窄宽度下横向滚动。
  - **窄面板降级**：结果区用容器查询（`@container (max-width: 360px)`）在窄宽度隐藏编码与聚合函数下拉——读数本身已带函数名（`SUM = 3,500`，列名在 tooltip 里），范围与读数优先保证可读。
- 多语句：一个脚本跑完，每条语句一个结果标签，标签上带「行数 · 耗时」；遇错即停（失败语句就是最后一个标签）。有选中时只跑选段（2026-10-19 落地）。
- 对象浏览：编辑器上方一条「对象」开关 + 对象摘要（`N 个库 · N 个对象 · 含 N 视图 · information_schema|SHOW`）。树层级对齐 DataGrip 的 Database Explorer：**数据源 → 库/Schema → 表 / 视图两个分组 → 对象 → 列**（`src/client/schema-tree.ts` + `components/SchemaTree.tsx`）。默认展开第一个库与其「表」分组（库下没有表时展开「视图」），筛选时自动展开命中项；单击插入光标处，双击 = 打开数据。
- 对象右键菜单（DataGrip 的 `Edit Data F4` / `Jump to Query Console` / `Go to DDL Ctrl+B` / `Copy Reference` / `Refresh` 映射为本面板能做的五件事）：表/视图 → 打开数据（写入编辑器并执行 `SELECT * … LIMIT 100`）、插入名称、复制引用（`\`库\`.\`表\``）、查看 DDL、刷新表结构；列 → 插入名称 / 复制列名；库 → 复制库名 / 刷新表结构。菜单贴点击点弹出，靠边时上翻/左翻（`menuPosition`），Esc、外部点击、滚动都关闭。
- 查看 DDL：`SHOW CREATE TABLE|VIEW` 走执行通道的 `raw` 模式（不进分页包裹、不跑 COUNT），结果在右下角浮层显示并可复制；库不返回语句时明确提示「数据库没有返回 DDL」，不把表名当 DDL 显示。
- **未做**（不假装做了）：DataGrip 树里的 Keys / Indexes / Triggers / Server Objects、`Jump to Query Console` 的独立 console 分派、DDL 差异比较。
- 补全下拉跟随光标：镜像测量 textarea 光标坐标，贴右下弹出，底部空间不足时上翻（`src/client/caret.ts`）。

### 6.6 结果区状态栏 / 窗口化行 / 值查看器（批次 5）

- **状态栏**（网格底部，`data-grid-status`）：左侧是范围（`整页 R 行 × C 列` 或 `选区 R 行 × C 列`），中间是**聚合器控件**——这与 DataGrip 一致（其状态栏有 aggregator widget，默认 `SUM`，点击控件切换函数，`Ctrl+Shift+C` 复制汇总值）：函数下拉 `SUM/AVG/MIN/MAX/COUNT/DISTINCT`、读数 `SUM(amount) = 3,500`、复制按钮。聚合作用于选区；无选区时作用于整页（受本页筛选影响），列默认取当前列、`null` 时退到第一个数值列。数值从**原始行值**解析而不是格式化后的文本（`Number('1,234')` 是 `NaN`）；NULL、空串、非数字一律跳过，避免把平均值拉到 0。右侧显示编码。
  - 差异说明：DataGrip 显示连接字符集；我们拿到的是已被驱动解码的 JS 字符串，线上字符集信息已经没了，所以这里诚实地显示**面板渲染编码**（`document.characterSet`），不冒充连接 charset。
- **窗口化行**（`src/client/rowwindow.ts`）：超过 200 行的页只把一屏 + 上下各 8 行放进 DOM，其余用等高 spacer 行撑住滚动高度（行高固定 30px，与 `.table td` 一致）。DataGrip 不需要这个——它用 `Limit page size to` 把页压到几百行；我们的页大小可到 5000，所以窗口化是必要差异。方向键移动后会用 `scrollTopForRow` 把选区带回可见范围。
- **值查看器**（`src/client/format.ts` 的 `fullValue`）：双击单元格或 `Shift+Enter`（DataGrip 的 `Open in Value Editor`）打开右下角卡片，显示完整值、字符数、列名与行号；JSON 能解析则美化，二进制显示前 64 字节 hex + 总字节数；可复制，`Esc` 或按钮关闭。换页时自动关闭（它指向的是旧页的行）。
- **布局**：结果区改成 flex 列（工具条 / 滚动区 / 状态栏），编辑器块由「固定不让位」改为可收缩（`flex: 0 1 auto` + `min-height: 96px`），结果区保底 `min-height: 132px`——否则在 444px 高的右栏里，工具条 40px + 状态栏 38px 会把滚动区挤成 0（真机实测过）。

## 2. token 映射表（用途 → `--dsw-alias-*`）

| 用途 | token |
|---|---|
| pane 底 | `--dsw-alias-bg-base` |
| 分区表面（连接条/编辑器/git 面板） | `--dsw-alias-bg-layer-1`（嵌套分区 layer-2） |
| 分区边框/表头边框 | `--dsw-alias-border-l1` / `-l2` |
| 主文本/次文本/弱文本 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` |
| tab 激活色、焦点圈、主按钮 | `--dsw-alias-state-business-primary` |
| 错误态 | `--dsw-alias-state-error-primary` |
| 成功/警告点 | `--dsw-alias-state-success-primary` / `-warn-primary` |
| 行 hover / 行选中 | `--dsw-alias-interactive-bg-hover` / `-active` |
| 网格表头底 | `--dsw-specific-sidebar-fill` |
| SQL 代码区 | `--dsw-alias-markdown-code-block` + `--ds-font-family-code` |
| 滚动条 | `--dsw-alias-scrollbar-bg-l1/l2`（浮层 rebind l2 对） |
| 字体 | `--dsw-font-family`；代码 `--ds-font-family-code`；字号 `--dsw-font-xs-13`(tab)/`-s-14`(正文) |
| 动效 | `--ds-ease-in-out` + `--ds-transition-duration*`，尊重 `prefers-reduced-motion` |

禁令（来自 web-styling.md）：组件 CSS 内禁 `[data-ds-dark-theme]` 选择器、禁字面量颜色、浮层自行 rebind 滚动条 token。

## 3. 组件复用清单（禁重复造轮子）

| 组件 | 来源 | 用途 |
|---|---|---|
| `Button`（variant primary/ghost/toolbar；size md/sm） | `@deepseek-ai/dsh-client-ui-primitives` | 执行/测试/pull/push/commit |
| `Input`（h32 r8） | 同上 | host/port/user/commit message |
| `Pill` / `StateDot` | 同上 | DBMS 标签、连接状态点 |
| `Menu` | 同上 | 连接选择器、页大小菜单 |
| `Modal` / `Tooltip` / `Toast` | 同上 | 确认框、图标提示、操作反馈 |
| `CodeBlock`（shiki） | 同上 | ~~SQL 高亮（编辑器区）~~ **不可用（2026-10-19 核实）**：0.2.1 的 composition 里没有 `@deepseek-ai/dsh-client-ui-primitives`，且 shiki 只渲染只读 HTML，压不住可编辑 textarea → 改为「透明 textarea + 着色层」，见 `src/client/highlight.ts` |
| `DiffBlock` | 同上 | git diff 预览 |
| `JsonTree` | 同上 | database-info/错误详情展开 |
| `IconDataOutline16`（L149）/ `IconPlayOutline16`（L553）/ `IconBranchOutline16`（L731） | 同上 | tab 图标、执行、git |
| 面板外壳结构 | `ui-conversation/.../skeleton/DetailsPanel.tsx`（分支） | header/关闭钮/滚动体模式 |
| tab 栏样式 | `ui-trajectory` `.detailTabs/.detailTab`（34px、gap 1px、2px 激活下条、role=tablist） | SQL sub-tab |
| 网格表格样式 | `ui-trajectory` `.table`（30px 行高、sticky th、hover/selected 背景） | 结果网格 |

## 4. 关键界面线框（ASCII）

### 4.1 连接条 + 测试

```
┌──────────────────────────────────────────────┐
│ [doris.shcell.com ▾] [⚙] [测试连接] ●已连接    │  ← 34px；StateDot: 绿YES/红NO/黄UNSURE
└──────────────────────────────────────────────┘
```

### 4.2 连接表单（Modal）

```
┌─ 连接配置 ────────────────────────────────┐
│ 名称 [doris.shcell.com    ]  DBMS [Doris▾] │
│ 主机 [doris.shcell.com    ]  端口 [9030  ]  │
│ 数据库 [                ]  用户名 [       ]  │
│ 密码 [••••••••••••  ] [仅本次会话☐]         │
│ 驱动属性 [+添加] rewriteBatchedStatements=T │
│ 写操作开关 [☐ 启用 writeEnabled]            │
│           [测试连接]  [取消]  [保存]         │
└────────────────────────────────────────────┘
```

### 4.3 编辑器 + 结果网格

```
┌─ [query_1.sql ×][query_2.sql ×][+] ── [▶执行] [⏹取消] [💾] ─┐
│ SELECT * FROM dwd_order WHERE dt = '2026-10-01'              │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ id▲      order_no     amount     created_at                 │ ← 列头可排序(服务端)
│ 100001   SO20261001   1299.00    2026-10-01 08:12:33        │
│ ...                                                          │
├──────────────────────────────────────────────────────────────┤
│ 第 1-500 行 / 共 103,572 行 (COUNT)   [⏮][◀][1/208][▶][⏭]   │ ← 分页条
│ 500 行 · 612ms · fetching 87ms            [页大小: 500 ▾]     │
└──────────────────────────────────────────────┘
```

### 4.4 git 面板（可折叠分区）

```
┌─ git ─ main↯2 [pull] [push] ─────────────────────┐
│ M query_1.sql   A query_3.sql                    │ ← status 列表
│ ┌ diff 预览 ─────────────────────────────────┐   │
│ + SELECT * FROM dwd_order WHERE dt='...'      │   │
│ - SELECT * FROM dwd_order                     │   │
│ └─────────────────────────────────────────────┘   │
│ [commit message: 修复订单日期过滤      ] [commit] │
└──────────────────────────────────────────────────┘
```

### 4.5 三态测试反馈

```
测试中: ● 黄(脉冲) "正在连接…"
成功:   ● 绿 "MySQL 5.7.99 (Doris 2.1.10) · mysql-connector…"
失败:   ● 红 "认证失败 (28000): Access denied for user 'x'"
        [提示: 检查密码/白名单] [详情▾(JsonTree)]
```

## 5. 交互状态矩阵

| 视图 | 空 | 加载 | 错误 | 成功 | 禁用 |
|---|---|---|---|---|---|
| 连接选择器 | "未选择连接" | — | 红点+重试 | 绿点+dbms 标签 | 无可用连接 |
| 测试按钮 | — | 脉冲点+"连接中" | NO 态+hint+详情 | YES 态+版本信息 | 表单未填必填项 |
| 编辑器 | 占位提示 | 执行中（⏹可点） | 错误行高亮+hint | 结果渲染 | 无连接/无选中语句 |
| 网格 | "执行查询查看结果" | 骨架行 | 错误横幅+重试 | 行数据+分页条 | — |
| 分页条 | 隐藏 | 禁用 | — | 首页/中间/末页三态 | 仅一页时禁用 |
| git 面板 | "目录未初始化 [init]" | 操作中 | 错误 output+重试 | status/diff | 无 remote 时 pull/push 禁用 |
| 大值单元格 | "NULL"(弱文本) | — | — | 超限: "⚠ 值过大(1.2MB)"+点击查看前 32KB | — |

## 6. 网格 UX 细节

1. **虚拟滚动**：渲染窗口 + 上下缓冲（DataGrip 有图像缓存与 cache factor，评估结论为实现细节；我们取"可视区×2"缓冲，按需升级）；
2. **列宽**：拖拽调整（列宽存连接级布局）；列头 sticky（`--dsw-specific-sidebar-fill`）；
3. **排序**：列头点击循环 无→ASC→DESC；服务端 ORDER BY 重新执行（页码重置）；当前排序列箭头指示；
4. **分页**：首页/上页/页码输入/下页/末页；页大小菜单（100/500/1000/5000/自定义）；COUNT 显示"总数未知"降级（05 §7）；
5. **格式化**：NULL 弱文本空；日期 ISO；数字千分位+右对齐；布尔 TRUE/FALSE；二进制 hex 预览；分发参照 DataGrip Formatter 家族（SPEC-sql §6）；
6. **复制**：选中单元格/区域/整列 → TSV（Excel 友好）或 CSV；表头可选；
7. **选择**：单元格/行/列/区域（Shift 扩展）；选中态 `--dsw-alias-interactive-bg-active`；
8. **键盘**：`Ctrl/Cmd+Enter` 执行；`Esc` 取消；`Ctrl/Cmd+S` 保存脚本；`Ctrl/Cmd+Shift+G` git 面板。

## 7. 可访问性

- tab 栏 `role="tablist"/"tab"/"tabpanel"` + `aria-selected` + `aria-controls`（抄 TrajectoryTable 模式）；
- 焦点圈统一 1px `--dsw-alias-state-business-primary` outline（offset -1）；
- 网格：列头 `aria-sort`；行可选导航；错误用 `role="alert"`；
- 动效尊重 `prefers-reduced-motion`。
