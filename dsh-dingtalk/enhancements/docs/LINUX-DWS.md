# Linux amd64 固定 DWS 制品

本页记录 Issue #24 的 Linux 制品支持，与 [SERVER-RUNTIME.md](SERVER-RUNTIME.md) 配套。生产部署优先在镜像构建时放入固定二进制，运行时不下载、不更新、不依赖宿主全局安装。

## 固定版本（与 `dws.lock.json` 一致）

| 项 | 值 |
| --- | --- |
| DWS | `1.0.66`，tag `v1.0.66`，commit `f215043e676d6889e1ddce3464828d8b1ec40c31` |
| Linux 归档 | `dws-linux-amd64.tar.gz`，`19396103` bytes，SHA256 `27cd2821e1f6523d1eeaf5688c23502bddbdd858cf82e32c197853065418bef8` |
| 归档内容 | `./`、`CHANGELOG.md`、`LICENSE`、`NOTICE`、`README.md`、唯一可执行 `dws`（`0755`） |
| 二进制 | `58091152` bytes，SHA256 `4ee71b2e1d1d4b888dd41dbda6193d213636971196f0641d4ef1c74d12b49607` |
| 架构 | ELF64、小端、ET_DYN、`e_machine=0x3e`（x86-64） |
| 平台矩阵 | 支持：`win32-x64`、`linux-x64`。仅元数据、未验收：darwin/linux-arm64。 |

`binaryChecksums` 现已包含 `linux-x64`；该校验值由官方归档实际解包后计算，并记录在 `dws.lock.json`。

## 校验与安装

```bash
# 归档 → 解出唯一 dws → 校验二进制 hash/模式 → 可选的安装目录
cd dsh-dingtalk/enhancements
pnpm run build
node scripts/verify-dws-artifact.mjs --archive ../.cache/dws-artifact/dws-linux-amd64.tar.gz --platform linux-x64 --install-dir ../.cache/dws-artifact/installed-linux --json
```

脚本先核对归档大小与 SHA256，再用内存中的严格 tar.gz 解析器提取**唯一** `dws` 普通文件（拒绝重复、缺失、符号链接/硬链接、路径穿越、绝对路径、校验和错误、deflate 格式错误），随后核对二进制 SHA256；指定安装目录时写入 `0755` 并拒绝 setuid/setgid。

## 运行时规则

- 自动安装路径：`ensureDws` 在缺少二进制时按平台选择官方归档，先校验归档再校验二进制，写入后重新 `verifyExecutable`；Linux 默认可执行名为 `dws`，Windows 为 `dws.exe`，不会把 `dws.exe` 误用于 Linux。
- 预装路径：`binaryPath` 必须是绝对路径；每次业务调用前重新校验真实路径、普通文件、可执行位、SHA256 与 ELF/PE 架构（setuid/setgid 拒绝）。
- 不支持的平台返回 `cli_platform_unsupported`，不会尝试下载或执行错误二进制。
- 版本固定：执行前运行 `dws --version` 并匹配 `dws version v1.0.66 (f215043e…`；不匹配返回 `cli_version_unsupported`。
- 未修改、未复制、未 fork 官方 DWS 源码。

## 证据

- 归档 SHA256 与二进制 SHA256 已由 `verify-dws-artifact.mjs` 在本地核对（Windows 主机上复用同一解析器），结果见 `connector/docs/evidence/artifact-linux.json`。
- 镜像构建阶段使用独立的 Node 版校验脚本 `connector/docker/verify-dws-artifact.mjs`（不依赖 apt/curl）：下载后校验归档 SHA256、用内存 tar.gz 解析器提取唯一 `dws`、校验二进制 SHA256、写入 `0555`、执行 `dws --version` 并匹配版本/commit；任一不匹配都会使构建失败。
- 固定 Linux 二进制在 `debian:bookworm-slim` 容器中以 root 和 `10001:10001` 非 root、只读根文件系统实跑，输出见 `connector/docs/evidence/dws-version-linux.txt`：

```text
dws version v1.0.66 (f215043e676d6889e1ddce3464828d8b1ec40c31, 2026-10-28T07:36:14Z)
版本检查: 当前 v1.0.66，暂时无法确认是否最新；可运行 dws upgrade --check 重试。
```

（`dws upgrade --check` 的网络提示出现在隔离网络中；插件与 Connector 子进程固定 `DWS_NO_UPDATE_CHECK=1`，不做在线升级。）
- 单元测试 `enhancements/tests/artifact.test.mjs` 覆盖 tar.gz 提取边界、平台矩阵与真实归档 hash；Connector 的 Linux 容器测试在启动前再次校验归档与二进制 hash 并执行 `dws --version`。

## 未验证项

- Windows 主机上 Connector 的 DWS 子进程路径（当前环境存在文件锁访问限制），因此服务端集成验证在 Linux 容器内完成。
- Linux DWS 1.0.66 的 `auth exchange` 对合成 code 走服务端托管换取，不使用本地合成 OAuth 端点；因此 Connector 的 OAuth/双用户流程用契约型 fake CLI（测试专用 seam）验证，真实固定二进制只验证 hash/ELF/权限/`--version`。真实企业授权仍待验收。
- 真实企业网络下的 DWS API/MCP 出网与代理链路；需要按部署网络单独验收。
- DWS 官方升级到新版本：必须重新计算归档/二进制 hash、更新锁文件与镜像 ARG，并重跑 `artifact.test.mjs` 与 Linux 容器测试。
