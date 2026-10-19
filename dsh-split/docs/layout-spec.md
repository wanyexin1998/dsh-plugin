# 分屏、会话与布局管理技术方案

对象：在 DeepSeek Harness `0.2.0-rc.2` 的 `desktop` profile 上，做一个与 Claude Code 分屏等价的插件。插件包是 `E:\dsh-plugin\dsh-split`，profile 已把它列进 `dsh.profile.bundles`。

本文分两部。第一部是与宿主无关的产品规格，按 Claude Desktop `2.31226.1.0` 里 Code 模式的已发布前端行为写成，是布局行为的验收标准。第二部是早先「浮层里嵌网格」的接法，已被 `docs/architecture.md` 取代；实现以架构文档为准，第一部的规则不变。

静态分析没有跑过运行时点击。Claude 里有一个拒绝某些 Code 会话进入格子的判断，其具体名单没有展开，插件侧用「同一会话只能占一格」代替，不猜测那份名单。

---

## 第一部　Claude Code 布局规格

### 1. 范围

做会话网格，不做会话内部的文件 / 预览 / 终端分栏。

会话网格决定「哪几个会话并排、各占哪一列哪一行、谁有焦点、比例是多少」。会话内部的 tile（文件标签、预览、终端、侧边对话）跟会话走，不跟格子走。关掉一块分屏只拿掉一个会话窗口，不关掉那个会话里的终端。

### 2. 领域模型

主会话不在数组里。它是当前路由。焦点下标 `0` 就是主格。

```ts
type SessionId = string

type PaneRef =
  | { kind: 'session'; id: SessionId }
  | { kind: 'draft'; nonce: number }

type Cell = {
  ref: PaneRef
  col: number          // 从 0 起；0 列与主格同列
  row: 0 | 1           // 0 上，1 下
  openedBy?: 'keyboard' | 'menu' | 'modifier' | 'drag' | 'sidebar' | 'other'
}

type Layout = {
  extras: Cell[]       // 下标 i 的焦点号是 i + 1
  focusedIndex: number // 0 = 主格
  colWeights: number[] // 与当前列数等长；缺省时按等分
  rowSplit: number     // 0.15 .. 0.85，默认 0.5
  maxColumns: number   // 1 .. 5，由窗口宽度重算，不持久化
  draftNonce: number
  parked: Cell[] | null
  constrained: boolean
}
```

身份：

- 草稿：`code-draft:<nonce>`
- 会话：稳定键，建议 `session:<id>`。同一键在主格和 `extras` 里最多出现一次。

常量：

| 名字 | 值 | 作用 |
| --- | --- | --- |
| `MAX_COLUMNS` | 5 | 硬上限 |
| `COLUMN_PX` | 360 | `maxColumns = clamp(1, 5, floor(width / 360))` |
| `MIN_PANE_PX` | 320 | 列拖动的下限 |
| `ROW_MIN` / `ROW_MAX` / `ROW_DEFAULT` | 0.15 / 0.85 / 0.5 | 上下分割 |
| `WEIGHT_FLOOR` | 0.01 | 列权重下限 |
| `HIT_NEW_COLUMN` | 最后一列右半 | 还能加列时，落点是新列 |
| `HIT_SPLIT_PRIMARY` | 主列左缘 16px 到 1/3 宽 | 拆开主列的窄条 |
| `DRAG_SLOP_PX` | 3 | 角拖动开始认方向 |
| `DRAG_CURSOR_PX` | 8 | 角拖动超过此距离才换移动光标 |

### 3. 不变量

实现必须把这些写成纯函数测试，UI 只调用它们。

1. 额外格的坐标永远不是 `(0,0)`。算出 `(0,0)` 时改成 `(0,1)`。
2. 列号从 0 连续。整理时集合里始终包含 0，即使 0 列没有额外格。
3. 某一列只有下格时，该格升到这一列的上格。
4. 下格存在的前提是同一列已有上格，或该列就是主列（主格算上格）。
5. 同一身份只占一个位置。再次打开只移动焦点。
6. 打开的就是当前主会话时，焦点回到 0，不新增格子。
7. 放进已有真实会话的格子是替换该格引用。放进草稿格时，先把草稿挪到下一个空位；没有空位则这次放置失败，状态不变。
8. 列数变化时丢掉该模式的 `colWeights`。下次按等分。
9. `focusedIndex` 始终落在 `0 .. extras.length`。关掉比焦点更靠前的格时下标减一。
10. `constrained === true` 时 `extras` 为空，原数组在 `parked`。解除时按原坐标放回；列数对不上的模式丢掉列权重。

### 4. 整理 `normalize(cells)`

```
t = 是否已有 (0,1)
结果 = []
对每个格子:
  若坐标是 (0,0):
    若 t 已真: 丢弃这格
    否则: 改成 (0,1)，t = 真，保留
  否则: 保留
列集合 = {0} ∪ 保留格的列号，升序
按这个集合把列号重写成 0..n-1
若某格 row=1 且同列没有 row=0: 把它改成 row=0
返回结果
```

### 5. 找空位 `nextSlot(cells, maxColumns)`

```
列数 = max(col) + 1
若 列数 < maxColumns: 返回 { col: 列数, row: 0 }
否则找最小的 col，其没有 row=1: 返回 { col, row: 1 }
否则返回 null
```

不指定落点时，空位用 `nextSlot`。满了就用最后一个非草稿格的坐标，等于替换它。草稿不算这个「最后一个」。

### 6. 放置 `place(state, ref, slot | null, via)`

前置：桌面端、当前模式允许分屏、`ref` 通过准入。不通过则状态不变。

```
若 ref 就是主会话: focusedIndex = 0；返回
若 ref 已在 extras: focusedIndex = 那一格 + 1；返回
目标 = slot ?? nextSlot；目标为 null 时按「替换最后非草稿」
目标若是 (0,0): 改成 (0,1)
若目标列 >= 当前列数:
  还能加列: 目标 = { 新列, 0 }
  否则: 落到最后一列；该列已有下格则 row=0，否则 row=1
若目标 row=1 且该列没有上格: row=0
若该格已有草稿:
  空位 = nextSlot；没有空位则失败返回
  草稿挪到空位，新 ref 占原格
若该格已有真实会话: 替换引用，焦点到该格
若该格为空: 追加，焦点到新格
列数变了: 删除 colWeights
normalize
```

### 7. 关闭、移动、交换

`close(index)` 只接受额外格（index ≥ 1）。删掉后 `normalize`。若关掉的是某列上格，且主列还没有下格，先把该列下格改到 `(0,1)` 再整理。列数变了就清列权重。焦点按不变量 9 修正。

`move(index, slot)`：

- 不能落到自己、不能落到 `(0,0)`、列不能为负。
- 目标格有人：交换两格坐标。
- 目标格空：仅当 `col < 列数` 或还能加列，且（`row=0` 或该列已有上格）时允许。然后 `normalize`。
- 焦点跟着被移动的那格。

`swapPrimary(cellIndex)`：主会话进入该格，该格原来的会话升成主会话。升成主会话的那个，带走它自己的内部 tile 布局；离开主格的那个，把内部 tile 布局存进自己的会话存档。有守卫时这次交换可以取消，状态不变。

`insertLeftOfPrimary(ref)`：现有额外列整体 `col + 1`，新会话放在 `{col:1, row:0}`。列数已满则失败。这会把原来贴着主列的内容右推一列。

### 8. 宽度与拖动

`maxColumns` 在宿主尺寸变化时重算，不写入存档。初始值 2，只用于还没量到宽度之前。

列权重是 `fr`。相邻两列拖动时，两列之和不变，每列至少 `max(一半里的较小值, 320px 对应的比例)`。已有三列以上时按住 Alt，改为挤压中间那一列、两侧一起变。双击列分隔：全部权重设为 1。双击行分隔或角：`rowSplit = 0.5`；角同时把列拉平。

行拖动只改 `rowSplit`，夹在 0.15 与 0.85。

角拖动同时改列和行。位移小于 3px 不计方向；超过 8px 才把光标换成 move。

分隔条热区 12px。列条贴列右缘，向两侧各 6px。行条在分割线上垂直居中。角是 12×12。

### 9. 落点

指针在侧边栏内：无落点。

否则按列矩形命中。最后一列右半且还能加列：新列上格。其余按指针是否低于 `高度 * rowSplit` 决定上格或下格。主列左侧 16px 到三分之一宽，且还能加列：拆主列。目标格是草稿且旁边还有空位：这次放置拒绝（让草稿留在原处，新会话去空位）。

提示文案：

| 条件 | 文案 |
| --- | --- |
| 还能拆出新位置 | Split view |
| 格内已是非草稿会话 | Open here |
| 移动到空位 | Move here |
| 与已有格交换 | Swap |
| 还不能放下 | 同一文案，胶囊改成中性灰、整体 45% 透明 |

### 10. 交互清单

侧边栏点会话：

| 操作 | 结果 |
| --- | --- |
| 普通点击 | 已在某格则聚焦。指针正停在某个额外格上，就在那格打开；否则在当前焦点格打开。是主会话则只聚焦主格。 |
| Alt+点击 | `place`，来源 `modifier` |
| Ctrl 或 Cmd+点击 | 弹出独立窗口，不进网格 |
| 右键 Split view | 同 Alt+点击 |
| 右键 New window | 同 Ctrl/Cmd+点击 |

键盘，仅桌面端：

| 动作 | Mac | Windows |
| --- | --- | --- |
| 下一格 / 上一格 | Ctrl+] / Ctrl+[ | 同左 |
| 右侧新开草稿或空位 | Cmd+Ctrl+\ | Ctrl+Alt+\ |
| 下方新开 | Cmd+Ctrl+- | Ctrl+Alt+- |
| 关闭焦点格 | Cmd+Ctrl+W | Ctrl+Alt+W |
| 焦点在格子间移动 | Cmd+Ctrl+方向键 | Ctrl+Alt+方向键 |

方向键移动焦点，不移动格子。移动格子只来自拖动和菜单。菜单要先问布局引擎「这一方向还能不能做」，不能做就不执行。

向右新开：还有列额度就新列，否则失败，状态不变。向下新开：焦点所在列还没有下格才成功。

点格子或在格子里按键：焦点到该格。不因此改路由，除非这次操作本来就是「把该格升成主会话」。

拖动手柄在每格顶上，44×8，默认几乎不可见，悬停出现 32×3 圆角细条。主格在允许移动时也有。

### 11. 视觉

网格是 CSS Grid。

- `grid-template-columns: var(--col-tracks, minmax(0, 1fr))`
- `grid-template-rows: minmax(0, calc(var(--row) * 100%)) minmax(0, 1fr)`
- 没有下格的列，上格 `grid-row: 1 / -1` 拉满。
- 有下格时上格只占第 1 行，下格占第 2 行，中间 1px 边框。列与列之间 1px 边框。
- 主格 `aria-label="Primary pane"`，额外格 `"Secondary pane"`。多格时当前格 `aria-current="true"`。
- 非当前格：不透明度 75%，饱和度 85%。头部操作默认隐藏，悬停 120ms 后出现。
- 新额外格 180ms 淡入。`prefers-reduced-motion` 时无过渡。
- 按住 Ctrl（Mac 为 Cmd）悬停可移动的格：光标 move，600ms 后强调色内描边。
- 拖动中，格内 iframe 和手柄 `pointer-events: none`。

侧边栏与网格是两套尺寸。侧边栏默认 288px，离窗口左缘 8px。主内容再让出该宽度加 8px。网格列宽不读侧边栏宽度，只读自己的内容盒。

### 12. 持久化

键：按账号分开的 `layout.v1`。版本 4 的语义如下，插件用自己的键，不要写进 Claude 的存储。

写入：`extras`（去掉草稿）、`colWeights`、`rowSplit`、`draftNonce`、上次主会话 id。

不写入：`focusedIndex`、`maxColumns`、`constrained`、`parked`。存盘前若处于 constrained，先把 parked 合并回 extras 再去掉草稿，存的是「解除约束后的布局」。

旧数据若只有三个具名槽（右上、右下、左下），读入时映射为 `(1,0)`、`(1,1)`、`(0,1)` 再 `normalize`。

### 13. 约束模式

窗口被停靠，或当前不是允许分屏的宿主时：若 `extras` 非空，整表放进 `parked`，`extras=[]`，焦点 0。解除时按不变量 10 恢复。停靠期间关掉的会话，恢复时不要加回来。

### 14. 模块边界

纯逻辑，无 DOM：

- `identity.ts`：身份键、重复检测
- `normalize.ts`
- `place.ts`：place / close / move / swapPrimary / insertLeft
- `geometry.ts`：maxColumns、权重夹紧、行夹紧、落点
- `persist.ts`：序列化、迁移、草稿剔除

有 DOM 的层只做三件事：把指针和键盘译成上面的命令，把 `Layout` 画成网格，把 `PaneRef` 交给宿主的会话渲染器。

### 15. 验收

用固定夹具测纯函数，不启动 UI。

- 放置到 `(0,0)` 变成 `(0,1)`。
- 同一 id 第二次 place 只改焦点。
- 主会话 place 只把焦点设为 0。
- 满列后再向下，落在第一个没有下格的列；都有下格则失败。
- 替换草稿时草稿被挪走；没有空位则原状态不变。
- 关掉上格且主列无下格时，原下格出现在 `(0,1)`。
- 列数增加后 `colWeights` 为空。
- `normalize` 后列号连续，且没有孤立下格。
- 宽度 359 → 1 列，360 → 1 列，720 → 2 列，1800 → 5 列，1801 仍是 5。
- 行拖到 0 和 1 被夹到 0.15 和 0.85。
- constrained 再解除，格子坐标与进入前一致；期间 close 过的 id 不再出现。
- 存档往返后草稿消失，会话格还在。

---

## 第二部　DSH 0.2.0-rc.2 插件方案

### 16. 宿主事实

运行的是 Electron 桌面应用，profile 是 `desktop`，版本 `0.2.0-rc.2`（`~\.dsh\logs` 的启动记录）。插件已经挂上：

- `~\.dsh\profiles\desktop\package.json` 的 `dependencies.dsh-split` 指向 `E:/dsh-plugin/dsh-split`
- `dsh.profile.bundles` 含 `dsh-split`
- 包的 `dsh.bundle.patch` 是 `cordis.patch.yml`，`dsh.client.platform` 是 `web`
- insert 行的 `name` 必须是裸包名 `dsh-split`。客户端按这个 specifier 挂 `exports["./client"]`

DSH 的能力全是 Cordis 插件。本插件是 profile bundle：宿主半边 `lib/index.js`，浏览器半边 `lib/client.js`。改浏览器半边可以被客户端模块热替换；改宿主半边或新增 `link:` 依赖需要重启一次 DSH。

公开的会话呈现面（`0.2.0-rc.2` 讨论与当前 conversation 契约，动手前用运行中的客户端类型再对一次名字）：

- `ctx.sessions.retain(id, { source })` 得到 `SessionReference`。source 用插件私有值 `splitPane`，不要写成 `mainView`。
- `SessionProvider session={reference}` 把引用收成会话作用域。
- `renderFactorySlot('conversation.content', { variant: 'embedded' })` 在该作用域里画出原生消息流、composer、工具卡。官方子代理侧栏走的是同一条缝。
- 工厂的本地槽 `views` 必须在格子里固定成「对话」。不固定时，格子会停在该会话上次选的轨迹或 diff，而格子没有原生顶栏可以切回来。
- `conversation.header` 由 `main.conversation` 独占声明。插件再声明同名子槽会在加载期抛错。格子顶栏只能自绘。
- `shell.overlay` 是 root 级 list，画在 frame 的浮动层，不参与三列网格，不挤压中间列。
- 右侧栏可见条件是没有全局面板占住主列（`activePanelId === null`）。用全局面板做分屏会把右侧栏关掉。浮层不占面板，右侧栏还在。
- 一个会话只有一份 composer 编辑器。同一会话出现两次，或被盖住的主列和格子同时挂载，会抢 `editor.setRootElement`。
- 文件拖放监听在 `document` 上，不区分焦点。多个格子同时挂着时，一次放下会进所有 composer。

`master` 上的契约可能比 `0.2.0-rc.2` 新。下面的槽名以本机这一版为准；对不上就改适配层，不要改布局引擎。

### 17. 与第一部的对应

| Claude Code | 本插件 |
| --- | --- |
| 主格 = 路由里的当前会话 | 主格仍是原生中间列里的当前会话。它不在 `extras` 里 |
| 额外格 | 浮层网格里的 `SessionProvider` + `conversation.content` |
| 内部 tile 随会话搬家 | 不另做快照。DSH 的会话存储已经按 session 分开。升成主会话只是 `openSession` |
| 账号级 layout store | `localStorage` 键 `dsh.split.layout.v1`，结构用第一部的持久化子集 |
| 独立窗口 | 第一期不做。DSH 没有对等的「把会话拖出进程」公开 API。菜单里不放 New window |
| 最多 5 列、每列最多 2 行 | 原样做。不做成任意二叉树。4 格是旧稿的内存上限，不是布局模型；列行上限仍按第一部，同时加「同时挂载的 transcript 不超过 6」的运行时闸 |
| Alt+点击、Ctrl+方向、分隔条、落点文案 | 原样做，键位用第一部的 Windows 列 |

做不到、必须改道的只有三件：

1. 网格不能插进原生三列布局。整个网格（含主会话的一份副本）画在 `shell.overlay` 里，盖住中间列。左右侧栏保持原生。
2. 格子没有原生会话顶栏。每格自绘 30px 标题条：会话名、关闭、拖动手柄。
3. 同一会话不能出现两次，因为编辑器是会话级单例。这和第一部的不变量 5 一致，在这里是硬故障而不是风格。

### 18. 架构

```
lib/index.js                 宿主半边。0.2 没有必须的宿主服务时保持空插件
lib/client.js                浏览器入口：注册 overlay、快捷键、侧栏菜单
lib/layout/identity.js
lib/layout/normalize.js
lib/layout/place.js
lib/layout/geometry.js
lib/layout/persist.js
lib/host/sessions.js         retain / release，source = splitPane
lib/host/editor-handoff.js   主列 inert、抢回编辑器、关闭时的空面板交接
lib/ui/overlay.js            浮层盒子。位置用主列 getBoundingClientRect，不走 React state
lib/ui/grid.js               只在结构变化时重渲染
lib/ui/pane.js               memo。props 只有 cell、reference、generation、是否已进场
lib/ui/hit.js                落点与分隔条，写 DOM，松手才提交
cordis.patch.yml
tests/layout.test.mjs        第一部第 15 节
```

纯布局模块禁止 import React、禁止读 `document`。测试直接跑它们。

数据流：

```
侧栏 / 键盘 / 拖动
        │  译成命令
        ▼
   layout engine  ──persist──►  localStorage
        │  新的 Layout
        ▼
   grid 结构重渲染（仅结构变化）
        │
        ▼
   每格 SessionProvider
        │
        ▼
   conversation.content  embedded，views 固定为对话
```

焦点、拖动高亮、分隔条比例不进 React state。焦点用 `classList`，比例在拖动中只写两个格子的 `flex` 或 grid 轨道变量，松手再 `setColWeights` / `setRowSplit`。

### 19. 浮层与编辑器交接

这是插件能工作的条件，不是装饰。

浮层打开：

1. `sessions.retain` 持有主会话和每个额外会话。引用由 controller 持有，浮层开关不释放，避免重放历史、丢掉草稿。
2. 注册 `shell.overlay` 项，盒子对齐中间列的 `getBoundingClientRect`（相对 overlay 层，含 Windows 标题带，不能从 0,0 画，否则盖住 drag 区）。
3. 根节点 `-webkit-app-region: no-drag`。
4. 被盖住的原生中间列设 `inert` 和 `aria-hidden`。编辑器归格子。

原生导航（侧栏点会话、新建会话）会让被盖住的主列为那个会话重挂，并再次绑定编辑器。插件在同一次提交里把对应格子的 `SessionProvider` key 加上 generation，使格子的 layout effect 后于主列执行，把编辑器抢回来。点格子本身只改本地焦点，不调用 `openSession`。否则主列重挂，输入框能打字但发不出去。

浮层关闭：

1. 先把主列停在一个空面板上（浮层还在，用户看不见）。
2. 下一帧卸浮层，把主列还给将要显示的那个会话。
3. React 先跑格子的卸载（释放编辑器），再跑主列的挂载（重新绑定）。

只剩 1 格（没有任何 extras）时自动关闭浮层，并把那一格的会话设为当前会话。

右侧栏跟随焦点：焦点格变化时调用应用级 `openSession`，让 `scope: 'session'` 的右侧栏跟上。栏收起时不导航、不重挂；栏打开时再补导航。每次跟随都会触发上面的抢编辑器。滚动位置在重挂前后保留。

右侧栏全屏时浮层让位，不盖住它。

文件拖放：浮层打开时在冒泡路径上挡住 `Files` 拖放，并提示改用回形针或 `/file`。这是为了不让一次放下写进每一个格子。

### 20. 命令到引擎

侧栏会话行菜单增加两项，满列且不能再向下拆时置灰：

- 向右分屏 → `place(session, { col: 列数, row: 0 }, 'menu')`，放不下则置灰
- 向下分屏 → `place(session, { col: 焦点列, row: 1 }, 'menu')`

浮层还没开时：锚点是当前主会话，它留在主格；被点的会话按方向进新格。被点的就是当前会话时，新格留空并聚焦（草稿或空选择器），因为同一会话不能占两格。用户再点侧栏另一个会话，填进这个空格。

浮层已开时：拆的是焦点格所在列。

Alt+点击会话行：`place(..., 'modifier')`。

Ctrl+点击：第一期不弹窗。保持原生行为，不拦截。

快捷键（Windows，与第一部一致）：

| 键 | 命令 |
| --- | --- |
| Ctrl+] / Ctrl+[ | 焦点 +1 / -1，环绕 `0 .. extras.length` |
| Ctrl+Alt+\ | 向右 `place` 一个空草稿格并聚焦 |
| Ctrl+Alt+- | 向下 `place` 一个空草稿格；该列已有下格则忽略 |
| Ctrl+Alt+W | `close(focused)`；浮层没开则忽略 |
| Ctrl+Alt+方向键 | 按列行移动焦点，不移动格子 |

空格显示会话选择器。选定后 `place` 进该格；若该会话已在别处，改为聚焦那一格并清空这个空格。

标题条拖到另一格：`move`。拖到落点区：用第 9 节的命中。提示牌用第 9 节的四句文案。

分隔条和角：第 8 节。双击复位。

### 21. 视觉在 DSH 里怎么落地

网格规则用第一部第 11 节。颜色不写死，读 DSH 已经放在 `body` 上的 token：

- 窗口底：`--dsw-alias-bg-base`（会话正文是透明的，composer 遮罩从 base 淡出；格子用别的底，深色下底部会出一条黑带）
- 浮层背后：`--dsw-specific-sidebar-fill`
- 描边：`--dsw-alias-border-l1`，聚焦升到 `l3`，不用彩色 outline
- 间距：外圈、格间距、分隔条热区统一 10px。分隔条就是这条缝

这些变量必须声明在 `body` 上。写在 `:root` 时 `--dsw-*` 还不存在，`var()` 会静默失效。

非当前格的 75% 不透明和 85% 饱和度加在格子外壳上，不要加在会话子树上，避免每条消息重绘。进场淡入放在外壳。`prefers-reduced-motion` 关掉全部过渡。

打开分屏时先画外壳（标题条和空卡片），然后每帧挂载一个格子的 transcript，焦点格优先。避免一帧里挂上所有会话。

### 22. 持久化与约束

键：`dsh.split.layout.v1`。内容是第一部第 12 节的子集。恢复时再跑一遍不变量：超列丢掉、重复会话清空、失效焦点退回 0、草稿不恢复。

浮层开合不持久化。重启后是关闭的，布局还在。用户用向右/向下或快捷键再打开。

DSH 没有 Claude 那种「停靠后整表收起」的窗口模式。`constrained` 只在这两处置位：插件卸载前把布局写入存档；右侧栏全屏时浮层让位但不清空 `extras`。不要在让位时 `close` 格子。

### 23. 实施顺序

每步都要能单独验收。不要先画 UI 再补不变量。

1. **引擎。** 实现第 2–9 节和第 15 节的测试。无 DOM。完成标准：`node tests/layout.test.mjs` 全过。
2. **空浮层。** 注册 overlay，按主列矩形摆一个网格，格子是空的。左右侧栏仍在。快捷键能改焦点和开关。完成标准：中间列被盖住，侧栏可点，右侧栏不消失。
3. **绑定。** `retain` + `SessionProvider` + embedded conversation，`views` 固定对话。主列 inert。同一次提交里抢回编辑器。完成标准：两格都能打字并发送，互不串稿。
4. **侧栏与菜单。** 第 20 节。完成标准：向右、向下、Alt+点击、重复点击只聚焦，和测试夹具一致。
5. **拖动与分隔条。** 落点文案、交换、双击复位。拖动过程中 transcript 不重渲染（React profiler 或一条计数断言）。
6. **关闭交接。** 关到一格自动回单窗口，原生 composer 能输入。右侧栏允许闪一帧，不允许输入框坏掉。
7. **持久化。** 刷新后格子和比例还在，浮层默认关闭，草稿不在。

### 24. 明确不做

- 不重写消息流、composer、工具卡、审批。
- 不声明 `conversation.header` 或任何 shipped 单槽。
- 不用全局面板换右侧栏。
- 不把同一会话放进两格。
- 不在插件里复制 Claude 的内部 tile 快照协议。
- 第一期不实现拖出独立窗口。
- 不持久化浮层开关。

### 25. 风险

| 风险 | 处理 |
| --- | --- |
| `0.2.0-rc.2` 的槽名和 master 不一致 | 第 3 步开始前，在运行中的客户端上确认 `conversation.content`、`shell.overlay`、`sessions.retain`、`openSession`。引擎不依赖这些名字 |
| 被盖住的主列仍在跑流式渲染 | 接受。它是编辑器交接的代价 |
| portal 到 `document.body` 的浮层不受中间列 `inert` 影响 | 接受。不在插件里改原生 portal |
| 右侧栏跟随引起主列重挂 | 用 generation 抢编辑器；滚动位置单独保存 |
| 六个以上 transcript | 运行时闸拒绝继续 `place`，菜单置灰 |
