# BOOP 支持矩阵（准备版）

> 规则：**只声明真实执行过的组合**。未测试的平台/版本一律 `NOT_RUN`，不得写成"支持"。
> 本矩阵随每次发布复核；宿主升级后旧证据只作历史，必须重新对齐复跑。
> 状态日期：2026-10-18。

## 1. 已声明 / 已验证

| 组合 | 状态 | 证据 |
|---|---|---|
| **Windows**（win32 x64）+ DSH **0.2.1-rc.2**（已安装 Desktop payload）+ Web profile（隔离 `$DSH_HOME`） | PASS（插件装配/鉴权/只读面/宿主集成） | 宿主测试套件：E00-01 11/11、E00-02 8/8、E01-01 5/5、E03-01 7/7、E04-01 assets 8/8、E02-04 15/15、E04-01b 9/9、E04-02 11/11、E04-03 16/16（全部在独立 `.work/test-runs/**` DSH_HOME） |
| **Windows** + 自托管 Qwen（`qwen3.8-27b`，OpenAI 兼容 vLLM 网关，196k 上下文） | PASS（真实模型链路） | E05-00 真实金标 8/8；E02-03 真实派发与对账 5/5 × 4 次连续运行；证据 `docs/development/evidence/{e05-00,e02-03}/` |
| Windows + DSH 自带 Node 运行时 **v24.21.0** | PASS（插件在宿主运行时加载） | 宿主测试启动日志/运行时探测；`- id` 解析与 API 调用均在该运行时下完成 |
| Windows + npm **11.16.0**（打包） | PASS（`npm pack` 产物校验） | `node tools/package-boop.mjs`；`docs/development/evidence/e07-02/package-report.md` |
| Windows + 本仓库测试运行器 Node **v24.18.0** | PASS（单元/客户端测试） | `node --test` 套件结果（见 `docs/development/STATUS.md`） |
| Web profile 的浏览器目标 Chrome 126（客户端 bundle 构建目标） | 声明目标，未做真实浏览器矩阵 | `build.mjs` target；真实浏览器截图/IME 为 `NOT_RUN` |

## 2. 未验证（NOT_RUN，不得宣称支持）

| 组合 | 状态 | 说明 |
|---|---|---|
| **DSH Desktop Electron GUI**（窗口、分屏、真实安装/卸载） | NOT_RUN | 只在 Web Host（隔离 DSH_HOME）验证过；Desktop GUI 回归等待 E07-01 |
| **真实用户 profile 安装 / 升级 / 回滚** | NOT_RUN | E07-02 只交付 runbook 与打包校验，未代用户安装 |
| **macOS** | NOT_RUN | 未在 macOS 上构建/运行/安装；不进支持列表 |
| **Linux** | NOT_RUN | 未在 Linux 上构建/运行/安装；不进支持列表 |
| 其他 Windows 版本 / 其他 CPU 架构 | NOT_RUN | 仅在当前 Windows x64 环境执行 |
| 其他 DSH 版本（含未来升级） | NOT_RUN | `engines.dsh` 精确声明 `0.2.1-rc.2`；升级需重新对齐，不申请版本豁免 |
| Node 22.x / 其他 Node 版本 | NOT_RUN | engines 声明 `^22.19.0 \|\| >=24.0.0`，但只在 24.x 实际执行 |
| 真实浏览器：Chrome/Edge 126 实机、IME、深浅主题截图、多标签 | NOT_RUN | 属客户端/一体化回归（E07-01） |
| 钉钉 / 飞书渠道 | NOT_RUN（默认关闭） | G07 `BLOCKED`（缺 IN-07/IN-08 凭证）；M2 联调 |
| 多 Host 并发 / Desktop + Web 同时指向同一数据域 | 部分验证 | 单写者租约与只读降级在 E01 验证；**租约无心跳**（15s TTL 可被第二 Host 接管）仍是已记录风险，E07-01 前必须补心跳或明确仅单 Host |
| 真实 GPU 性能 / 3D 动画帧率 | NOT_RUN | 资产包自述未在真实 GPU 上验证 30fps |

## 3. 版本门槛（装载时强制）

- `package.json` 声明 `engines.dsh = "0.2.1-rc.2"`，不满足的宿主会**拒绝加载**该 bundle；
  BOOP 的市场定位是"与已验证宿主精确对齐"，**不申请版本豁免**来绕过兼容门。
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
