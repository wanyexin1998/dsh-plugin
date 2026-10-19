# v5 视觉与 DOM 契约

## 2026-10-16 当前实现修订（优先于下方冻结原型记录）

根据用户连续确认的视觉修订：取消重复会话标题与 Sidebar 标题，使用 8px 无矩形焦点框的透明拖拽热区；键盘焦点以短线提示。Sidebar 的收起/全屏/还原使用原生控件，全屏限所属会话。内层布局采用 CSS Grid，不再逐像素回写 React 几何。

"关闭此分屏"由插件自绘为**会话列（`.v5-conversation`）里、原生会话 Header 同排最右侧的会话级操作按钮**：`button.v5-session-close[data-dsh-split-close]`，绝对定位 `top:11px; right:12px`，28×28px、圆角 8px、15px 描边叉、`z-index:25` 高于 16% 非聚焦蒙层；只在"该会话是 2 个及以上分屏之一"时渲染，单 pane（普通视图）不显示。锚在会话列而不是会话外壳，是为了在原生 Sidebar 停靠右侧并展开、列宽变化时仍贴在 Header 右端；列被隐藏时（Sidebar 全屏 / 窄屏 Sidebar 独占）按钮随之隐藏，此时左侧会话菜单的"关闭此分屏"仍在。

**边界例外（仅此一处，与下方"scope 终点"规则并列，另有先例：原生 dock 首列重复左边线的抑制）**：`[data-v5-workbench] .v5-native-conversation [data-slot="conversation.header"] > header { padding-right: 64px }`（并有 `> header` 直接子级兜底）。原生 Header 的实际层级是 `.v5-native-conversation > 原生根节点 > [data-slot="conversation.header"] > header`，选择器因此用 `data-slot` 结构属性定位槽位包装、只取它的直接 `header` 子级，不会波及消息内容里的 `<header>`，也不依赖 hashed 类名。原因：原生 `headerCorner` 用 `margin-left:8px; margin-right:-16px` 把自己的最后一级控件塞进 28px 的右内边距里，实测 ▯（原生 Sidebar 控件，28×28）右边缘距 Header 右边缘只剩 12px，不足以容纳 28px 的会话操作按钮。把这一个内边距加宽 36px，正好把原生一组（actions / utilities / corner）整体左移一位，让出按钮所需的角落：插件按钮与 ▯ 间距 8px、距 Header 右边缘 12px（与原生留白惯例一致）。副作用仅限标题行提前 36px 截断；原生单会话视图没有 `.v5-native-conversation` 包装，完全不受影响。真实宿主验证里有对应几何断言（`paneCloseInline`）。

为什么不放进原生 Header 槽位：`conversation.session.header.actions` 与 `.utilities` 都在原生代码的 `!hideChrome` 分支里，空会话（新建会话分屏后的常态）只渲染 `header corner`，而那个 single 槽位属于原生 Sidebar 控件；`conversation.header.leading` 是 root 作用域、无会话身份。因此原生 Header 没有"每个 pane 恒在、且不替换原生控件"的位置。原生 `header.corner` 仍归 Sidebar 控件所有，插件不抢。

分屏工作区使用左侧栏原生背景变量 --dsw-specific-sidebar-fill，顶部、底部各留 8px 真实留白，引擎测量其实际可用尺寸。左侧栏与工作区同色；工作区、聚焦会话与非聚焦会话保留三层底色，每个会话内部底色一致；非聚焦使用同色 16% 蒙层淡化文字。

Sidebar 恢复原型的 12px 圆角、1px 细边框、12px 正文间距和本文件所列静态轻阴影。边框采用 DSH 原生主题 token 的 55% 色强；去掉原生首列重复的左边线，内部列分隔线保持。会话内部左右及底部留 8px（窄屏 6px），允许 Sidebar 阴影在 body 范围外延伸，但始终裁切在所属会话内。正文、编辑器、原生标签的样式不覆盖。以下保留为原型来源记录，旧标题栏、控件归属、绝对定位规则不再适用于当前实现。

本文件与 `src/styles.css` 只依据冻结目录 `reference/dsh-split-v5-frozen-20261015/` 中的 `dsh-split-interactive-demo.html` 和 `dsh-split-final-plan.html` 编写。没有参考历史插件源码、构建产物或样式。原型用于确定插件外壳与交互反馈；正文、编辑器、Sidebar 标签和 provider 内容由原生组件呈现。

## 视觉边界

- 唯一工作区根为 `[data-v5-workbench]`，宽高 `100%`、`min-width/min-height: 0`、相对定位、裁切工作区外溢。
- 每个插件 portal 根都必须有 `[data-v5-overlay]`，并独立同步 `data-theme="light|dark"`。portal 不依赖工作区祖先继承主题。
- 所有插件 CSS 位于工作区/overlay scope 内；`.v5-native-conversation`、`.v5-native-sidebar` 为 scope 终点。Dockview 的基础 CSS 应采用相同的 scope 终点，避免进入原生 Sidebar 自己的 Dockview。**唯一例外**是上文记录的会话 Header `padding-right` 加宽（外加已有先例：原生 dock 首列重复左边线的抑制），两处都必须带 `[data-v5-workbench]` 前缀、用结构选择器、并在真实宿主验证里有几何断言。
- 原生 wrapper 只获得占满容器与 `min-size: 0` 的尺寸规则。不得给原生消息、输入框、终端、Tab、iframe 增加插件皮肤，不能复制原型中的模拟内容。
- 不增加原型导航栏、appbar、提示条、调试标记、模拟会话或体验指南。

## 固定结构

```text
[data-v5-workbench][data-theme]
  .v5-engine                 // new DockviewComponent 的宿主
    .dv-dockview              // 引擎自动生成的外层布局
    …always-render containers…
      .v5-panel-mount         // createComponent 返回的固定元素
        .v5-session[data-active][data-compact][data-tight]
          header.v5-session-head
            button.v5-session-title
              svg.v5-grip
              span.v5-letter
              span.v5-title-text
              span.v5-title-status
            .v5-head-actions
              button > svg + span.v5-button-label (可选)
          .v5-session-body
            .v5-conversation
              .v5-native-conversation > 原生 Conversation
            .v5-inner-divider[data-axis="x|y"][data-resizing][role="separator"]
            aside.v5-sidebar
              header.v5-sidebar-head
                button.v5-sidebar-title > svg.v5-grip + span + small
              .v5-sidebar-content
                .v5-native-sidebar > 原生 Sidebar
            button.v5-mobile-return (仅 Sidebar 独占时显示)
```

`.v5-panel-mount` 为相对定位、宽高 100%。`.v5-session` 为相对定位的纵向 flex、宽高 100%，不得以换挂载点方式移动会话。`.v5-session-body` 为相对定位。正文、Sidebar 与内部拖拽槽只更新 `left/top/width/height`，三者均为绝对定位；位置变更不替换节点。

`data-active`、`data-compact`、`data-tight` 使用字符串 `"true"`/`"false"`。参考原型：会话宽度小于 `680px` 为 compact，小于 `450px` 为 tight。compact 隐藏按钮文字和标题状态；tight 将标题文本最大宽度限制为 `104px`。浏览器视口不超过 `800px` 使用原型窄屏间距。

## 几何与层级

| 元素 | 冻结值 |
| --- | --- |
| 会话外壳 | 圆角 12px，无 border、outline 和 box-shadow |
| 会话标题栏 | 高 45px，左右 padding 10px，gap 8px |
| 会话标题 | gap 7px，标题字 12px/500，状态字 9px/400 |
| 标识字母 | 21×21px，圆角 5px，字 10px |
| 会话操作按钮 | 高 28px，最小宽 28px，左右 padding 6px，图标 15px |
| 会话 body | margin `0 12px 13px` |
| Sidebar | 圆角 12px，1px 细边框，静态轻阴影 |
| Sidebar 标题栏 | 高 36px，padding `0 7px 0 10px`，底边 1px |
| Sidebar 标题 | 字 11px/500，归属字 9px/400，抓手宽 11px |
| 外层会话间距 | 12px；布局引擎负责保留可调整的透明空间 |
| 内层正文/Sidebar 间距 | 12px；geometry 负责命中槽矩形 |
| 内层手柄 | 默认透明，hover/focus/resize 时显示中央 2×30px 淡色条 |
| 外层手柄 | 默认、hover、focus、resize 全部透明；无伪元素描线 |
| 窄屏标题栏/body | 左右 padding 6px；body margin `0 8px 10px` |

Sidebar 标题栏只有整条可点击/拖动的标题。不得添加右上角收起、移动、更多等额外图标。收起由会话标题栏入口承担，四方向停靠菜单由 Sidebar 标题承担。

会话外层引擎设置 `--dv-separator-border`、`--dv-sash-color`、`--dv-active-sash-color` 为 `transparent`。引擎原始 tabs/header 隐藏；引擎仍须通过本身的无标题栏配置计算内容尺寸。CSS 不能代替引擎布局配置。外层分隔区域保留键盘焦点与调整行为，视觉上不画线；插件按钮、菜单项、输入与选择框有 2px 的 `focus-visible` 轮廓。

## 主题原值

| Token | Light | Dark |
| --- | --- | --- |
| bg | `#faf9f6` | `#20201e` |
| surface | `#fffefb` | `#292925` |
| ink | `#282824` | `#e8e7df` |
| muted | `#77766e` | `#aaa99d` |
| faint | `#aaa99f` | `#79796f` |
| line | `#e1dfd7` | `#41413a` |
| hover | `#eae8e0` | `#383832` |
| 非当前会话遮罩 | `rgba(140,148,157,.075)` | `rgba(162,170,180,.045)` |
| Sidebar 阴影 | `0 1px 2px rgba(24,28,21,.035), 0 4px 12px -4px rgba(24,28,21,.065)` | `0 1px 2px rgba(0,0,0,.12), 0 4px 12px -4px rgba(0,0,0,.20)` |

非当前遮罩是 `.v5-session::after`，覆盖含标题的整个会话，`z-index: 20`，`pointer-events: none`，opacity 100ms ease-out。它不设置 disabled、inert、透明度滤镜或内容 visibility；首次点击必须直接进入原生交互。浅深色不能用同一高透明度灰层。

## Portal 结构

每个根元素带 `[data-v5-overlay][data-theme]`，可直接将 class 放在根元素上。几何位置由交互控制器使用视口坐标写入。

- `.v5-menu[role="menu"][data-kind="session|sidebar"]`：可含 `.v5-menu-title`、`.v5-menu-label`、`.v5-menu-note`、`button[role="menuitem"]` 和 `hr`/`[role="separator"]`；Sidebar 四方向使用 `menuitemradio` 与 `aria-checked` 表示当前位置。会话菜单最小宽 218px，其他菜单 145px，圆角 10px。禁用原因以 note/title 提供，不用颜色作为唯一说明。
- `dialog.v5-dialog`：必须用原生 `showModal()`/`close()` 管理 top layer、backdrop 与焦点。内部使用 `.v5-dialog-head`（h2、p、关闭 button）、`.v5-dialog-body`、`.v5-dialog-footer`、`.v5-field-label`、`.v5-direction-buttons`。方向按钮用 `aria-pressed="true"` 或 `data-selected="true"` 表示选择；footer 使用 `.v5-primary`/`.v5-secondary`。
- `.v5-drag-shield`：fixed 全视口，z80，透明且接收指针；可设置 `data-axis="x|y"` 切换 resize 光标。
- `.v5-drag-scope`：z82，Sidebar 当前会话的边界；`.v5-edge-label[data-side="left|right|top|bottom"]` 表示四方向。
- `.v5-drag-preview`：z85，1.5px 虚线、10px 圆角；子 `span`/`label`/`.v5-drag-preview-label` 显示落点说明。
- `.v5-drag-ghost`：z90，7px 圆角，源会话或 Sidebar 的简短标签。
- `.v5-toast`：z130，底部 45px，居中，最大宽 `min(560px,85vw)`，不接收指针。
- `.v5-empty`：工作区空态，h2/p/操作按钮；不添加模拟会话。
- `.v5-projection-note`：临时放大/窄屏投影的简短状态及恢复按钮，不能放调试信息；容器不拦截点击，只有其按钮接收指针。

## 交互验收项

1. 两个会话与两个 Sidebar 的浅色/深色截图中，外壳同为 12px 圆角，外会话边界无线，Sidebar 有轻阴影且右上角无附加图标。
2. hover、拖动、键盘 focus 外层分隔区域时，computed background、border、outline、伪元素均不产生线。实际拖动仍改变两侧尺寸。
3. 非当前会话的正文、输入、终端与 iframe 首次点击即激活和操作；遮罩不吞输入。
4. Sidebar 四方向切换后，相同 native wrapper、iframe、终端节点保持；仅几何变化。
5. 标题、菜单、对话框使用键盘可达，Esc 返回合理焦点；Sidebar 内层 divider 可见焦点提示。
6. 窄屏 body 与标题间距正确，不产生横向溢出；Sidebar 独占投影有返回按钮。
7. reduced-motion 时只停用插件的动画与过渡，不覆盖原生内容样式。
8. 原生 Sidebar 内的 tabs、分隔区域与 provider 样式未受到外层 Dockview CSS 和插件通用 button/svg 规则影响。

这些条目是集成验收要求。编写 CSS 本身不代表已完成浏览器、原生 DSH 或 Electron 验收。

## 组件与测试夹具

`src/overlays.tsx` 导出 `SidebarMenu`、`MoveDialog`（别名 `MoveSessionDialog`）、`DragOverlay` 和 `Toast`；它们不自行创建 portal。菜单处理方向键、Home/End、Tab、Esc、外部点击和焦点返回。移动对话框在提交前重新检查参照会话和目标方向，原生 dialog 负责 top layer；外部卸载关闭 dialog 时不会再次触发提交方的 `onClose`。Toast 在 3500ms 后隐藏，替换消息会重启计时。

`tests/overlays.test.mjs` 的 8 项事件测试覆盖：菜单键盘导航与取消、明确选择、外部点击不抢焦点、提交前失效复核、移动目标与方向、目标列表清空、从对话框内部拖到 backdrop 不误关、Toast 更换与卸载计时。每项同时断言没有未捕获组件异常。JSDOM 使用明确的 dialog/rectangle shim，因此这些结果不证明浏览器 top layer、真实排版或原生资源保活。

`tests/fixture.html` 加载 `../dist/fixture.js`、`../dist/fixture.css` 和 `../lib/client.css`。测试夹具运行真实的新 Workbench，桥接、会话、正文和 Sidebar provider 均为合成替身，不连接 DSH、模型、文件或 PTY。其 UI 提供主题、600px 容器、刷新恢复和仅清理夹具存储的重置入口。

夹具的 `window.__v5Evidence` 只公开只读 getters：面板几何、稳定节点标识、合成草稿、iframe 页面输入/计数、挂载/引用/加载计数、终端计数与捕获的异常。没有布局动作函数、可执行字符串入口或内部 Workspace 引用。浏览器验收通过实际 UI 完成操作，以该证据读取身份与生命周期；夹具结果仍不等同于真实 DSH/Electron 验收。
