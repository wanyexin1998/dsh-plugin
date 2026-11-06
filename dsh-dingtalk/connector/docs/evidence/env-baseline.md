# 本机环境基线复现记录（非交付代码问题）

本文件记录 Issue #24 验证期间发现的一处**与本分支改动无关**的本机 Windows 限制，用于解释为什么 3 个既有 DWS 集成测试在本机失败，以及为什么服务端 Connector 验证放在 Linux 容器内。

## 现象

在本机 Windows 环境，用**固定的官方 DWS 1.0.66** 执行带预期身份断言的授权码换取：

```text
dws auth exchange --code-stdin --client-id=... \
  --expected-corp-id=... --expected-user-id=... --format=json
```

在全新的临时配置目录中失败（不涉及本仓库任何代码）：

```json
{
  "error": {
    "actions": ["dws doctor --json"],
    "category": "auth",
    "code": 2,
    "message": "local login state cannot be safely updated: acquiring file lock: opening lock file: open <tmp>/.data.lock: Access is denied."
  }
}
```

同一临时目录中 `dws --version`、`auth status --readonly`、以及不带 `--expected-*` 的自动路径均可执行；用 Node/PowerShell 直接创建 `.data.lock` 文件也成功。DWS 进程自身创建该锁文件被系统拒绝，属于本机执行环境（DSH/Windows 文件访问策略）限制。

## 基线对照

- 分支基线：`main@9cffa4999ac924183a5addfa5314a6b35e258c58`。
- 在基线的独立 worktree 中构建 `enhancements` 后运行
  `node --test --test-name-pattern "Host identity entry shares" tests/identity.test.mjs`：
  结果与改动分支一致失败（0 pass / 1 fail），说明该失败在本分支改动之前已存在。

## 受影响的既有测试

本机全量 `enhancements/tests/*.test.mjs`：71 tests / 68 pass / 3 fail。3 个失败都依赖"带 `--expected-*` 的真实 DWS 授权码换取"：

- `tests/capabilities.test.mjs`: _pinned official CLI performs generic read/write through synthetic OAuth and MCP endpoints_
- `tests/identity.test.mjs`: _Host identity entry shares the Web authorization and never uses another enterprise or user_
- `tests/identity.test.mjs`: _IM approval is native, and a pending approval cannot survive disconnect or reauthorization_

本分支新增的测试全部通过：

- `enhancements/tests/artifact.test.mjs`（Linux 归档/二进制/提取边界）
- `enhancements/tests/remote.test.mjs`（远端 Backend 映射与拒绝路径）
- `connector/tests/unit.test.mjs`（配置/状态/服务器 OAuth）
- `connector/tests/linux.test.mjs`（Linux 容器：真实固定 DWS 制品校验 + 双用户流程）

## 服务端验证方式的调整

Linux DWS 1.0.66 的 `auth exchange` 对合成授权码走服务端托管换取，不会使用本地合成 OAuth 端点；因此 Connector 流程测试使用测试专用 seam `DSH_CONNECTOR_TEST_DWS_BINARY`（契约型 fake CLI，仅测试模式解析）驱动，真实固定 Linux DWS 另行校验 SHA256/ELF/权限/`--version`。真实企业授权仍需在真实企业环境验收。

## 生产镜像构建

生产镜像 `connector/docker/Dockerfile` 在构建阶段从固定 release URL 下载归档，因此需要构建机出网到 GitHub Release。本机无法稳定访问 GitHub CDN（直连 302 后停滞），第二轮验证使用 `--build-arg DWS_ARCHIVE_URL=<mirror>` 完成端到端构建；归档与二进制 SHA256 仍由锁文件固定并在构建阶段校验，因此镜像内容不受镜像站影响。构建产物为非 root 镜像，`version`、`serve`、`health` 均通过，见 `production-image.txt`。同等语义的 Linux 测试镜像 `connector/docker/Dockerfile.test` 使用同一固定归档与校验。生产 Dockerfile 已由 `check-pins.mjs` 校验 ARG 与锁文件一致，构建脚本 `connector/docker/verify-dws-artifact.mjs` 复用与 `artifact.test.mjs` 相同的严格 tar.gz 提取规则。
