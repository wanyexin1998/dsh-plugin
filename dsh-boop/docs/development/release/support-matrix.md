# BOOP 支持矩阵（准备版）

> 规则：**只声明真实执行过的组合**。未测试的平台/版本一律 `NOT_RUN`，不得写成"支持"。
> 本矩阵随每次发布复核；宿主升级后旧证据只作历史，必须重新对齐复跑。
> 状态日期：2026-11-10。下表只保留这次仍成立的计数；更早的整表快照在 `STATUS.md` §1.5。

## 1. 已声明 / 已验证

| 组合 | 状态 | 证据 |
|---|---|---|
| **Windows**（win32 x64）+ DSH **0.2.1-rc.2**（已安装 Desktop payload）+ Web profile（隔离 `$DSH_HOME`） | PASS（插件装配、写模式按门账本打开、控制行不派发） | 2026-10-27 复跑：E00-02 7 通过 / 1 跳过（未设 Qwen）、E01-01 6/6、E02-04 15/15、E04-01b 10/10、E04-03 16/16、E07-01 模型不可达 4/4、审批并发 4/4。全部在独立 `.work/test-runs/**` |
| **Windows** + 自托管 Qwen（`qwen3.8-27b`，OpenAI 兼容 vLLM 网关，196k 上下文） | PASS（真实模型链路，宿主为当时的 rc.2 载荷） | E05-00 真实金标 8/8；E02-03 真实派发与对账 5/5 × 4 次连续运行；证据 `docs/development/evidence/{e05-00,e02-03}/`。2026-11-10 未在 0.2.2-rc.1 上重跑，当天真实模型用例 SKIPPED |
| Windows + 本仓库测试运行器 Node **v24.22.1** | PASS（2026-11-10 单元） | `node --test` 跑了 `mvp-turn-release`、`mvp-slot`、`poc-switch`、`e03-05-host-init`，18/18。宿主套件进程是 runtime v24.21.0 |
| Windows + DSH 自带 Node 运行时 **v24.21.0** | PASS（插件在宿主运行时加载） | 宿主测试启动日志/运行时探测；`- id` 解析与 API 调用均在该运行时下完成 |
| Windows + npm **11.16.0**（打包） | PASS（`npm pack` 产物校验） | `node tools/package-boop.mjs`；`docs/development/evidence/e07-02/package-report.md` |
| Windows + 本仓库测试运行器 Node **v24.18.0** | PASS（更早的单元/客户端测试） | 见 `docs/development/STATUS.md` 的历史计数。2026-11-10 的单元测试改在 v24.22.1 上跑 |
| Windows + DSH Desktop **0.2.1-rc.3** GUI（隔离 `$DSH_HOME`） | PASS（2026-10-27 窗口） | 运行 `desktop-gui-1793092410382`。这次截图已在 2026-11-10 被 `desktop-gui-1794292802095` 覆盖；当前 `report.md` 只描述 0.2.2-rc.1 |
| Windows Web 双 Host 同一数据域 | PASS（第二 Host 只读） | `tests/host/e01-01-storage-in-host.test.mjs`：第一 Host 心跳期间第二 Host 只读且 fencing token 不变 |
| **Windows** x64 + DSH Desktop payload **0.2.2-rc.1**（提交 `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`）+ 隔离 Web profile | PASS（装载与下列宿主套件） | 2026-11-10：载荷 `.work/test-host/payload-0.2.2/dsh`。E00-01 11/11。E00-02、E01-01 6/6、E02-04 15/15、E03-01 7/7、E04-03 16/16、E07-01 审批并发 4/4、模型不可达 5/5、杀进程重启 5/5。E02-03：5 通过，真实模型 1 条 SKIPPED；SIGKILL 后启动对账名单包含该 action，账本为 `outcome_unknown`。`boop_dispatch` 在模型不可达回合上占槽并在 `turn/end` 错误后放开。用户 `~/.dsh` 未改 |
| **Windows** x64 + DSH Desktop **0.2.2-rc.1** GUI（隔离 `$DSH_HOME`） | PASS（窗口、任务板写模式开启、浅色/深色、停用后恢复） | `docs/development/evidence/desktop-gui/report.md`，运行 `desktop-gui-1794292802095`。控制行仍不派发。用户 `~/.dsh` 未改 |

## 2. 未验证（NOT_RUN，不得宣称支持）

| 组合 | 状态 | 说明 |
|---|---|---|
| 真实浏览器多视口矩阵 | NOT_RUN | Edge 上的 IME 与桌面浅色/深色已有单独证据；三视口全矩阵未跑 |
| **真实用户 profile 安装 / 升级 / 回滚** | NOT_RUN | E07-02 只交付 runbook 与打包校验，未代用户安装 |
| **macOS** | NOT_RUN | 未在 macOS 上构建/运行/安装；不进支持列表 |
| **Linux** | NOT_RUN | 未在 Linux 上构建/运行/安装；不进支持列表 |
| 其他 Windows 版本 / 其他 CPU 架构 | NOT_RUN | 仅在当前 Windows x64 环境执行 |
| 其他 DSH 版本（除已列出的 rc.2、rc.3、0.2.2-rc.1） | NOT_RUN | `engines.dsh` 只列已核对版本；再升级必须重新对齐，不申请版本豁免 |
| DSH **0.2.2-rc.1** 上的真实 Qwen 回合 | NOT_RUN | 金标与真实派发的 PASS 属于更早载荷。这一版只跑了模型不可达的错误回合 |
| Node 22.x / 其他 Node 版本 | NOT_RUN | engines 声明 `^22.19.0 \|\| >=24.0.0`，但只在 24.x 实际执行 |
| 真实浏览器：三视口全矩阵 | NOT_RUN | Edge IME 与桌面浅色/深色已单独记录；完整视口矩阵未跑 |
| 钉钉 / 飞书渠道 | NOT_RUN（默认关闭） | G07 `BLOCKED`（缺 IN-07/IN-08 凭证）；M2 联调 |
| Desktop 与 Web 同时指向同一数据域 | NOT_RUN | Web 双 Host 已验证；桌面进程与 Web 进程同时打开同一账本未跑 |
| 真实 GPU 性能 / 3D 动画帧率 | NOT_RUN | 资产包自述未在真实 GPU 上验证 30fps |

## 3. 版本门槛（装载时强制）

- `package.json` 声明 `engines.dsh = "0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.2-rc.1"`。宿主用 semver 比对这个范围（含预发布），范围外的版本会**拒绝加载**该 bundle。
  这是对已核对构建的对齐，**不申请 `compatibility.json` 版本豁免**。
- `engines.node` 为声明范围；升级 Node 后需重新执行宿主测试。
- 每次 DSH 升级（例如 rc.2.2）都必须走 `docs/development/RC21_ALIGNMENT.md` 式重新对齐流程，
  旧版本的 PASS 证据不能直接作为新宿主证据。

## 4. 复核方式

```powershell
# 环境事实
node --version
npm --version

# 打包校验（Windows/npm 11.16.0 已跑）
node tools/package-boop.mjs

# 常规宿主集成套件（隔离 DSH_HOME，不写用户 ~/.dsh）
node --test --test-force-exit tests/host/<suite>.test.mjs
```

未执行过的组合保持 `NOT_RUN`，不写"预计可用"。
