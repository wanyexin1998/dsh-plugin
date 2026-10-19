# 已作废

按「在现有浮层上换布局树」来写的增量方案。不要按它开工。现行架构是 `docs/architecture.md`。布局行为仍以 `docs/layout-spec.md` 第一部为准。

# 重构方案：把现有分屏改成 Claude Code 的列网格

对象：`E:\dsh-plugin\dsh-split` 里已经跑通的插件。宿主是 DSH `0.2.0-rc.2` 的 `desktop` profile。产品目标是尽快复刻 Claude Desktop `2.31226.1.0` 里 Code 模式的会话网格。布局规则的完整定义在 `docs/layout-spec.md` 第一部，本文只写「现有代码怎么改」。

## 结论

不要重写插件。`lib/client.js` 里浮层、编辑器交接、`conversation.content`、引用、右侧栏跟随、文件拖放围栏、窗口样式，都是 DSH 上正确的做法，Claude 的桌面壳没有这些约束，照抄会把右侧栏关掉或把输入框写坏。

要换掉的是布局。现在是一棵对等的二叉树，最多 4 格，任意方向对半切。Claude 是「主格 + 额外格」的列网格：最多 5 列，每列最多上下两格，主格固定在第 0 列上格。交互、快捷键、落点、存档都跟着这套模型走。

最快的路径是：布局规则抽成纯函数，controller 改成发这些命令，`SplitOverlay.renderNode` 改成画网格。交接和会话渲染保持原样。

## 现有代码里留下的部分

这些函数和注册已经对上 DSH 的限制，重构时只改它们读的状态形状，不改协议。

| 已有实现 | 位置 | 重构时 |
| --- | --- | --- |
| `shell.overlay` 只盖中间列，不占 `activePanelId` | `apply` 里 `dsh-split: overlay` | 保留 |
| 空面板 `dsh-split-void`，关闭时先停靠再还主列 | `closeOverlay`、`repairOnTeardown` | 保留 |
| `sessions.retain(id, { source: 'splitPane' })` | `retainFor` | 保留。引用仍按格子 id 存在 `refs` |
| `SessionProvider` + `conversation.content` embedded，视图固定对话 | `PaneConversation`、`FixedChatView` | 保留 |
| 导航落到已显示会话时 bump `gens`，同一次提交抢回编辑器 | `bumpPaneShown`、`adoptCurrent` | 保留抢编辑器。格子选择规则按下面「侧栏点击」改 |
| 点格子只 `focusPane`，不 `openSession` | `Pane` 的点击 | 保留 |
| 右侧栏跟随焦点，收起时推迟，打开时补上 | `syncRightbarToFocus` | 保留。焦点改成数字下标后，仍用「焦点格的 sessionId」做跟随 |
| 滚动位置在重挂前后保存 | `capturePaneScroll` / `restorePaneScroll` | 保留 |
| 浮层按主列 `getBoundingClientRect` 定位，根节点 `no-drag` | overlay 测量 effect | 保留 |
| token 声明在 `body`，格子底色 `bg-base` | `CSS` | 保留。网格轨道改 CSS Grid，颜色变量不动 |
| 主列 `data-dsh-center` / `data-dsh-covered`，右侧栏窗口样式，全屏让位 | `markCenter`、`setCovered` | 保留 |
| 文件拖放在浮层根上拦住 | `fenceFiles` | 保留 |
| 外壳直接写 DOM，分隔条松手才提交，内容 `memo`，分帧挂载 transcript | `Splitter.preview`、`Pane` 的 props | 保留这三层。分隔条从「一棵 split 的 flex」改成「列轨道变量 + 行变量」 |
| 持久化 200ms 去重，卸载时 flush | `schedulePersist` / `writeLayout` | 保留节奏。键和内容换掉 |
| 只剩一个会话时关掉浮层，回到原生单窗口 | `closePane` 末尾 | 保留。触发条件改成「extras 为空」 |
| 30px 自有标题条、空格会话选择器、右侧栏按钮 | `PaneChrome`、`PanePicker` | 保留。标题条增加拖动手感，选择器继续充当 Claude 的草稿格 |

`lib/index.js`、`cordis.patch.yml`、`package.json` 的 exports 不动。

## 现有模型与 Claude 的差距

现在的节点是：

```ts
{ t: 'p', id, s }                     // 对等格子，s 为会话 id 或 null
{ t: 's', id, dir: 'row'|'col', r, a, b }
```

操作是 `splitPane`（把一格切成 0.5/0.5）、`swapPanes`（只交换两格内容）、`setRatio`（夹在 0.12–0.88）。上限 `MAX_PANES = 4`。快捷键是 `Ctrl+Alt+S` 开关、`Ctrl+Alt+1..4` 聚焦、`Ctrl+Alt+W` 关闭。拖标题条只做交换。存档键 `dsh.split.v1`，写入整棵树和焦点。侧栏菜单「向右 / 向下」调用 `splitWith(sessionId, dir)`。

Claude 有、现在没有的能力：

1. 主格与额外格。主格不在 extras 里，焦点 `0` 是主格。同一会话第二次打开只聚焦。
2. 列网格。最多 5 列；`maxColumns = clamp(1, 5, floor(宽度 / 360))`；每列最多两行；单格下限约 320px。
3. 放置，而不是「把当前格对半切开」。还能加列就新列上格；列满了就落到第一个没有下格的列；都满了则这次失败。`(0,0)` 一律改成 `(0,1)`。
4. 落到已有会话是替换引用。落到草稿格时先把草稿挪到空位，没有空位则整次取消。
5. 移动到空位、与已有格交换坐标（会话留在各自的格子对象上，只换坐标）。把主格拖进某一格，等于该格会话升成主会话。
6. 列宽是一组权重，相邻列拖动时两列之和不变。三列以上按住 Alt 挤压中间列。双击列分隔等分；双击行分隔或角把上下比回到 0.5，角同时等分列。
7. 落点文案：`Split view` / `Open here` / `Move here` / `Swap`。放不下时同一文案，胶囊中性灰、45% 透明。
8. 快捷键（Windows）：`Ctrl+]` / `Ctrl+[` 环绕焦点；`Ctrl+Alt+\` 向右新开；`Ctrl+Alt+-` 向下新开；`Ctrl+Alt+W` 关闭焦点格；`Ctrl+Alt+方向键` 在格子间移动焦点，不移动格子。
9. 侧栏 Alt+点击 = 放置。普通点击：已在某格则聚焦；指针正停在某个额外格上就在那格打开；否则写入当前焦点格。
10. 关掉某列上格时，若主列没有下格，该列下格先挪到 `(0,1)` 再整理列号。
11. 存档不写草稿、不写焦点、不写 `maxColumns`。有额外格时界面直接是分屏，而不是等用户再按一次开关。

现在多出来、Claude 没有、但 DSH 必须留的：浮层开关本身、编辑器交接、右侧栏跟随、文件拖放围栏、自有标题条。`Ctrl+Alt+S` 改成「退出分屏」（清空 extras 并关闭浮层），给已经记住这个键的人一条退路。它不再是进入分屏的方式。进入只来自菜单、Alt+点击、向右/向下快捷键。

独立窗口（Claude 的 Ctrl/Cmd+点击 New window）这一期不做。DSH 没有把会话拖出进程的公开 API。

## 目标状态

替换 `state.root` 那棵树。引用表、generation、open/closing、右侧栏跟随用的那些字段留在 controller 里。

```ts
type Cell = {
  id: string           // 仍是 retain / generation / DOM 的键
  sessionId: string | null
  col: number
  row: 0 | 1
}

type LayoutState = {
  primaryId: string
  primarySessionId: string | null
  extras: Cell[]
  focusedIndex: number          // 0 = 主格，k>0 = extras[k-1]
  colWeights: number[] | null   // null = 等分；列数变化时置 null
  rowSplit: number              // 0.15 .. 0.85，默认 0.5
  maxColumns: number            // 由宽度重算，不写入存档
  open: boolean
  closing: boolean
}
```

身份键：`session:<id>`，草稿（`sessionId === null`）用格子 id，不持久化。同一 `session:<id>` 在主格和 extras 里最多出现一次。

显示出来的格数 = `1 + extras.length`。几何上限是 5 列 × 每列 2 行，主格占掉 `(0,0)`，所以额外格最多 9 个、同时可见最多 10 格。这是 Claude 的上限，用来替换 `MAX_PANES = 4`。10 条 transcript 的成本用现有的分帧挂载扛，不再用 4 格把布局模型裁掉。宽度不够时 `maxColumns` 先把「还能不能加列」关掉，菜单和快捷键置灰。

不变量、`normalize`、`nextSlot`、`place`、`close`、`move`、列权重夹紧，按 `docs/layout-spec.md` 第 3–8 节实现，一个字不改语义。下面只写它们接到现有 controller 上的样子。

## 文件

`lib/client.js` 已经是 ESM（`tests/unit-bundle.mjs` 用 `import()` 加载它），可以在工厂外面 import 纯模块。布局模块禁止碰 React 和 `document`。

```
lib/layout/constants.js    MAX_COLUMNS=5, COLUMN_PX=360, MIN_PANE_PX=320,
                           ROW_MIN=0.15, ROW_MAX=0.85, ROW_DEFAULT=0.5
lib/layout/normalize.js
lib/layout/place.js        place, close, move, swapPrimary, insertLeftOfPrimary
lib/layout/geometry.js     maxColumnsFor(width), 列权重夹紧, 行夹紧, 落点
lib/layout/migrate.js      读 dsh.split.v1 的树，压成主格 + extras
lib/client.js              controller、组件、注册。删掉二叉树那一段
tests/layout.test.mjs      直接 import 纯模块，夹具用 layout-spec 第 15 节
tests/unit-bundle.mjs      继续测注册、引用、交接、存档；断言从「树形」改成「格子坐标」
```

`createController` 里现在的 `listPanes` / `replacePane` / `removePane` / `setRatio` / `withSession` / `prune` / `sanitize` / `stripExtraPanes` / `uniqueSessions` / `clampRatio`（约 86–210 行）整段删掉，改成调用 `lib/layout`。`migrate.js` 在删掉之前把「把旧树压平」抄出去，因为上线后还要读用户已经存下的 `dsh.split.v1`。

## Controller 怎么改

`panes()` 改成按阅读顺序返回 `[主格, ...extras]`：先列后行，列号升序，同一列上格在下格前。分帧挂载、`data-split-panes`、引用遍历都继续用这个数组。

`paneOfSession`、`assignSession`、`retainFor`、`forgetPane` 的键仍是格子 id。主格用 `primaryId`，不要为了「主格不在数组里」另做一套引用表。

`focusPane(paneId)` 改成 `focusIndex(index)` 与 `focusPane(paneId)` 两个入口，内部都写成 `focusedIndex`。右侧栏跟随继续看焦点格的 `sessionId`。点格子不导航，这条保持。

`splitPane(paneId, dir)` 删除。菜单和快捷键改调 `place`。

`splitWith(sessionId, dir)` 改成：

```
若 sessionId 已在主格或 extras 中，且当前已经是分屏:
  聚焦那一格
  返回
若 sessionId 就是当前主会话，且还没有分屏:
  按方向放一个草稿格（sessionId = null）并聚焦
  打开浮层
  返回
否则:
  主格若还不是当前会话，先把当前会话写入主格
  place(sessionId, 方向对应的槽位, 'menu')
  成功则打开浮层
```

方向到槽位：向右 = `{ col: 当前列数, row: 0 }`，由 `place` 在列满时改落到下格或失败。向下 = `{ col: 焦点所在列, row: 1 }`，该列已有下格则失败。`canSplit` 用同一次试探的纯函数（不改状态）决定菜单是否置灰。

`swapPanes` 改成 `move(fromIndex, slot)`：

- 目标格有会话或草稿：交换两格的 `col/row`，引用和 generation 留在各自的格子 id 上。这样拖动不再重挂 transcript。现在的 `swapPanes` 交换的是 sessionId，会让两格重挂，这是要去掉的。
- 目标是空槽：把格子移过去，然后 `normalize`。
- 被拖的是主格、目标是额外格：`swapPrimary`。主格的 sessionId 与该格对调，并 `normalize`。右侧栏按新的焦点会话跟随。

`closePane`：

- 关掉的是额外格：按 layout-spec 第 7 节，必要时把该列下格挪到 `(0,1)`，再 `normalize`，列数变了就 `colWeights = null`。焦点下标若大于被关下标则减一。
- extras 变空：把主格会话交给原生（现有的 `followCurrent`），然后 `closeOverlay`。
- 不提供「关掉主格」。主格的关闭按钮置灰。Claude 的关闭只作用于额外格。

`setRatio(splitId, ratio)` 删除。换成 `setColWeights(weights)` 和 `setRowSplit(value)`。拖动过程只写 DOM 上的 `--col-tracks` 和 `--row`，松手再调用这两个。

`openOverlay`：少于两个可见格时直接返回，这条保留。打开前若主格还没有当前会话，把当前会话写入主格，这条也保留。

`materialize`：遍历主格和 extras。会话已不在目录里的格子清空为草稿；草稿不 retain。恢复结束后若 `extras` 里至少有一个非草稿格，调用 `openOverlay`。这是相对现在的行为变化：以前重启后浮层是关的，布局只是躺在存储里。Claude 有额外格时界面就是分屏。

`adoptCurrent`（侧栏普通点击、原生导航）改成：

```
sessionId = 当前会话
若它已在某格: 聚焦那格，bump 该格 generation，返回
若指针下是某个额外格（paneAt）: 把 sessionId 写入该格，聚焦它，bump，返回
否则: 写入焦点格（焦点是主格就替换主会话），bump
```

Alt 已经在「放置」里处理，这条路径不再为 Alt 做第二件事。`openSession` 仍由原生侧栏发生，所以右侧栏、标题、高亮继续跟着走；编辑器仍靠 generation 抢回。

## 界面

`renderNode` 删掉。`SplitOverlay` 在打开时渲染一个网格：

```css
display: grid;
grid-template-columns: var(--col-tracks, repeat(var(--cols), minmax(0, 1fr)));
grid-template-rows: minmax(0, calc(var(--row) * 100%)) minmax(0, 1fr);
```

每个可见格 `grid-column: col+1`，`grid-row` 为 1 或 2。某一列没有下格时，该列上格 `grid-row: 1 / -1`。主格 `aria-label="Primary pane"`，额外格 `"Secondary pane"`。多格时焦点格 `aria-current="true"`。

非焦点格的外壳：不透明度 0.75，饱和度 0.85。加在格子外壳上，不加在会话子树上。新额外格 180ms 淡入；`prefers-reduced-motion` 时无过渡。现有的聚焦边框（`l1` 升到 `l3`）留着，和这层罩叠在一起。

分隔条：

- 列与列之间一条，热区 12px，拖动只改相邻两列权重，两列之和不变，每列至少 `max(一半中的较小值, 320px 对应比例)`。三列以上且按住 Alt：挤压中间那一列。
- 有下格的列一条行分隔，只改 `rowSplit`，夹在 0.15–0.85。各列共用一个 `rowSplit`，与 Claude 一致。
- 右下角 12×12。位移小于 3px 不计；超过 8px 光标改成 move。双击列分隔：权重全部置 1。双击行分隔或角：`rowSplit = 0.5`；角同时等分列。

落点由 `geometry.hit(pointer, layout, width)` 算出，拖动中用 class 画提示牌，不把指针写进 React state。文案：

| 条件 | 文案 | i18n key |
| --- | --- | --- |
| 新列或新的下格 | Split view | `drop.split` |
| 格内已有会话，拖进来的是另一个会话 | Open here | `drop.open` |
| 把自己的格子拖到空位 | Move here | `drop.move` |
| 与已有格交换 | Swap | `drop.swap` |
| 放不下 | 同一文案，加 `data-drop-hint` | 样式：胶囊中性灰，整体透明度 0.45 |

标题条拖动继续用现有的 pointer 监听和 5px 阈值。松手时调用 `move` / `swapPrimary`，不再调用只交换内容的 `swapPanes`。

侧栏拖动放在第二步：在会话行上按下并移动超过阈值后，使用同一套落点。若行的 DOM 选择器在 0.2.0-rc.2 上不稳定，这一步可以晚于键盘和标题条拖动，不阻塞其余能力。

`maxColumns` 用浮层盒子的 `ResizeObserver`（现有测量 effect 上加一行）调用 `maxColumnsFor(width)`。变小到放不下当前列数时跑 `normalize`，多出来的列按 layout-spec 的整理压回去；列数变了就丢掉 `colWeights`。

## 快捷键

`COMMANDS` 换成：

| id | 键 | 行为 |
| --- | --- | --- |
| `focus-next` | `Ctrl+]` | `focusedIndex = (i+1) % 可见格数`。浮层没开则忽略 |
| `focus-prev` | `Ctrl+[` | 同上，减一 |
| `new-right` | `Ctrl+Alt+\` | `place` 草稿到新列。没有额度则忽略 |
| `new-below` | `Ctrl+Alt+-` | `place` 草稿到焦点列的下格。已有下格则忽略 |
| `close` | `Ctrl+Alt+W` | 关闭焦点额外格。焦点在主格或浮层没开则忽略 |
| `focus-move` | `Ctrl+Alt+方向键` | 按列行找相邻格并聚焦。不调用 `move` |
| `exit` | `Ctrl+Alt+S` | 清空 extras，关闭浮层，主格会话回到原生单窗口 |

`Ctrl+Alt+1..4` 删除。方向键和 `]` `[` 的修饰键不同，`observeFixedInput` 不能再假设每条命令都是 Ctrl+Alt。每条命令自己写 modifiers。`]` 和 `[` 在焦点位于输入框时也要生效：Claude 的分屏焦点键不留给编辑器。实现时若快捷键座位在 composer 聚焦时不派发，改到 window capture，并在 `modal !== null` 时仍放弃。

菜单保持两项。「向右分屏」「向下分屏」改走上面的 `splitWith`。满了置灰。

Alt+点击会话行：在 sidebar 上挂 capture。`event.altKey` 且目标能解析出 sessionId 时，`preventDefault` + `stopPropagation`，调用 `place(sessionId, null, 'modifier')`。解析不出 sessionId 就放行，让原生点击继续。

## 存档

新键 `dsh.split.layout.v1`。旧键 `dsh.split.v1` 只读一次。

写入：

```json
{
  "v": 1,
  "primarySessionId": "…",
  "extras": [{ "id": "…", "sessionId": "…", "col": 1, "row": 0 }],
  "colWeights": [1, 1],
  "rowSplit": 0.5
}
```

不写 `focusedIndex`、`maxColumns`、`open`、草稿格。`writeLayout` 在序列化前把 `sessionId === null` 的 extras 滤掉，再 `normalize`。

读取旧树（`migrate.js`）：

```
panes = 旧的 listPanes(prune(root))，按深度优先、先 a 后 b
第一个 sessionId 非空的格子 → primarySessionId
其余非空 sessionId 按 nextSlot 依次 place
比例丢弃（二叉树的 r 对不上列权重）
超出几何上限的从末尾丢
焦点不恢复，focusedIndex = 0
```

读完写成新键。旧键留着，不删除，避免一次写坏后无法再迁。

## 测试

`tests/layout.test.mjs` 覆盖 layout-spec 第 15 节，不加载 `client.js`。这是重构完成的第一道门。

`tests/unit-bundle.mjs` 里这些断言会失效，按新语义改，不要为了让旧断言通过而保留二叉树：

| 现断言 | 改成 |
| --- | --- |
| 新鲜布局是一棵空 pane | 主格一个，`sessionId === null`，extras 为空，浮层关闭 |
| 第一次菜单打开后是两格，当前会话 + 被点会话 | 主格是当前会话，extras[0] 是被点会话，坐标符合方向 |
| 第四格之后拒绝第五格 | 在 `maxColumns` 和「每列已有下格」同时满足时拒绝；宽度给够 5 列时，第 5 个额外格仍然成功 |
| `swap` 交换 session 且树里留着 null 子节点 | `move` 交换坐标；持久化结果里没有草稿；引用次数不变 |
| `Ctrl+Alt+S` 关闭再打开 | `Ctrl+Alt+S` 清空 extras 并关闭。再次进入要用菜单或 `Ctrl+Alt+\` |
| `Ctrl+Alt+1` 聚焦第 1 格 | `Ctrl+]` 把焦点从 0 移到 1 |
| 存档 `v === 1` 且含 `root` | 新键含 `primarySessionId` 和 `extras`，不含 `open`、不含草稿 |
| 恢复后浮层仍关闭 | 恢复出非空 extras 后浮层是开的 |

注册形状、`source === 'splitPane'`、不影子 shipped 槽、空面板、关闭时 `panel:null`、generation 只 bump 被导航的那格、teardown 释放全部引用：这些断言保持，它们锁的是宿主层。

## 实施顺序

每步结束都要 `node tests/layout.test.mjs` 和 `node tests/unit-bundle.mjs` 全过。不要并行改交接和布局。

1. **纯引擎 + `layout.test.mjs`。** `client.js` 先不动。完成标准：第 15 节夹具全过。
2. **状态换型，界面仍能开两格。** controller 改用 `LayoutState`，`renderNode` 改成网格，菜单的向右/向下能摆出正确坐标。交接、retain、右侧栏跟随原样调用。完成标准：两格能打字发送；关到只剩主格回到原生输入框；旧的 `dsh.split.v1` 能迁进来。
3. **快捷键表换成上一节。** 完成标准：`]` `[` 环绕，`\` 和 `-` 在满列时是空操作，`W` 不关主格，`S` 退出分屏。
4. **分隔条、角、双击复位、落点四句文案。** 拖动中 transcript 不重渲染（沿用现有「松手才 setState」）。
5. **侧栏普通点击按「已打开则聚焦 / 指针下的额外格优先」改 `adoptCurrent`。** Alt+点击走 `place`。
6. **标题条拖动改成 move / swapPrimary。** 侧栏拖进网格用同一落点。
7. **恢复即打开。** 有额外格的存档在 `materialize` 之后把浮层打开，主列 `inert`，编辑器在格子里。

第 2 步做完就已经是可演示的列网格。第 4–6 步补齐 Claude 的操作面。不要把第 1 步和浮层重写并在同一次改动里。

## 不做

- 不重写消息流、composer、工具卡。
- 不声明 `conversation.header`。
- 不改成全局面板。
- 不把同一会话放进两格。
- 不实现拖出独立窗口。
- 不把 Claude 的内部文件/预览/终端 tile 快照搬过来。DSH 的会话存储已经按 session 分开，升成主会话只是换 `primarySessionId` 并让右侧栏跟随。
- 不在这次重构里改右侧栏的窗口样式和 10px 间距。
