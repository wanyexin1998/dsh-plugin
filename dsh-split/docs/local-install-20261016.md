# 2026-10-16 本机修复版安装记录

安装时间：2026-10-16 11:00:36（Asia/Shanghai）。状态：**安装文件已更新并核验**，重新打开 DSH 加载。没有自动启动/重启应用，没有执行真实附件上传、模型请求或终端操作。

## 修复内容

- 附件按实际拖放的会话接收，不再由监听器注册顺序决定；支持非焦点格子和侧栏子会话，拒收禁用/无归属目标，保留原生目录识别。
- 每格 Sidebar 独立保活；切换焦点、折叠不丢状态；新增/关闭其他格子不重挂载其余 Sidebar；关闭视图、退出分屏和插件卸载时按原生引用规则释放。
- 同时安装上一阶段的会话注入、作用域、冷启动重试及两项布局修复。

## 安装前验证

| 检查 | 修复版 | 负向验证 |
| --- | --- | --- |
| 布局纯逻辑 | 17/17 | — |
| 本机 rc.2 renderer 集成 | 5/5 | 第一阶段原版 0/5 |
| 真实附件模块与 Composer | 11/11 | 原版 1/11 |
| Sidebar 生命周期与真实 React portal | 8/8 | 原版 0/8；单独移除 portal key 可复现其他格子重挂载 |
| 真实 Chrome + Dockview | 水平/垂直分屏、12px 间隔、缩放、样式作用域和分隔线通过 | 第一阶段已复现原版覆盖导航、短条布局 |
| TypeScript、构建、客户端模块守卫 | 通过 | — |
| 补丁重建 | 24 个锚定修改、28 个文件逐字节一致 | 原件 SHA-256 校验通过 |

合计 41 项自动化回归。附件测试从真实模块的 `apply()` 注册开始，使用合成文件/DOM 事件；侧栏执行真实类和组件，使用明确的会话/快照测试替身。上述结果不扩大为真实 Electron 文件上传、PTY、中文输入法或全部 v5 功能验收。

日志：[附件](evidence/bugfix-20261016/attachment-routing-after.txt)、[侧栏](evidence/bugfix-20261016/sidebar-retention-after.txt)。历史未修复产物保存在 `docs/evidence/bugfix-20261016/before-host-fixes/patched/`。

## 实际加载文件

| 文件 | SHA-256 |
| --- | --- |
| `E:/dsh-plugin/dsh-split/lib/client.js` | `8ecdbc972d5a4c7bf24a5b0eb0b8b7b5a82f1182b5bd61cc90edbe2e547b1053` |
| `patches/patched/dsh-client-ui-attachment/lib/client.js` | `0f54931521da35fb27a8279773cbd200ec3aa3e6ebeea2f0b0efd1b95452ab92` |
| `patches/patched/dsh-client-ui-sidebar-right/lib/client.js` | `eaf6a0b189421c3a62739ba466e916f2a98b98337bdddcfacdf9a3bf22af2f25` |

`C:/Users/wanyexin/.dsh/profiles/desktop/node_modules/` 下的插件和 3 个宿主包 junction 均指向上述仓库与补丁目录。安装后通过这些路径读取的哈希与测试候选一致，全部 28 个补丁文件核验通过。profile 配置和 `E:/deepseek-harness/resources/app.asar` 未改动。安装收据见 [install-receipt.json](evidence/bugfix-20261016/install-receipt.json)。这里的核验指磁盘加载路径，不表示已打开的窗口完成热更新。

## 备份与回退

完整备份：`E:/dsh-plugin/dsh-split/backups/local-fix-20261016-110035621/`，包含安装前 `lib/`、`patched/`、补丁记录、Cordis 行和 desktop profile 配置。安装器另备份了 `lib.bak-install-20261016030035952/`。

若要撤销本轮修复，先退出 DSH，再运行：

```powershell
& 'E:/dsh-plugin/dsh-split/backups/local-fix-20261016-110035621/restore.ps1'
```

然后重新打开 DSH。该脚本同时恢复安装前的插件和两份宿主补丁，不删除会话或其他文件。通用安装器打印的 `--uninstall` 是卸载插件流程，不是本轮精确回退；本轮应使用上述专用脚本。

安装操作记录脚本为 [install-tested-release.ps1](evidence/bugfix-20261016/install-tested-release.ps1)，固定校验本轮测试哈希并在失败时恢复备份；它是一次性记录，不用于后续版本重复安装。
