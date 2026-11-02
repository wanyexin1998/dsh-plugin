# G0 本地复现

当前支持 Windows x64、PowerShell 7、Node `^22.19 || >=24`、Python 3。以下命令从仓库根目录执行。网络仅用于下载公开发行依赖；OAuth 模拟服务只监听 `127.0.0.1`。不会启动真实钉钉授权或模型请求。

## 1. 下载并验证 DWS

```powershell
pwsh -NoProfile -File dsh-dingtalk/scripts/g0/bootstrap-dws.ps1
```

发布制品下载到忽略的 `.cache/dingtalk-g0/`，先核对官方 checksums.txt 的 SHA256，再核对制品清单与安装包 SHA256，解压后核对二进制 SHA256。仅生成本地缓存，不修改 PATH。已有 `bin-amd64` 时拒绝覆盖；使用已有已校验二进制，或显式指定新的 `-CacheDirectory`。

其他平台的制品元数据已锁定，但本次未运行；bootstrap 不会将未验证的平台伪装成已支持。

## 2. 采集公开命令与 Schema

```powershell
node dsh-dingtalk/scripts/g0/collect-dws.mjs
```

默认读取 `.cache/dingtalk-g0/bin-amd64/dws.exe`，可通过 `--binary` 指定其他绝对路径，但仍强制核对二进制哈希；输出用 `--out` 指定。13 个采集项包括版本、授权帮助/预演/只读状态，以及三项 operation 的 help 和 compact Schema。

运行环境仅继承必要系统变量，不继承用户的 DWS、钉钉、DSH 或模型密钥变量。配置在随机临时目录，升级检查关闭；Windows 注册表凭证另用测试命名空间隔离。清理失败会使脚本失败。公开声明命令仍可能建立日志目录，报告如实记录这些文件，但不允许生成凭证配置。

## 3. 本项目额外 OAuth 夹具

```powershell
node dsh-dingtalk/scripts/g0/verify-exchange.mjs
```

覆盖在线身份断言、Profile A/B 与默认身份保持、错误身份拒绝、dry-run 无 stdin/无网络、403 失败保留已有 Profile、损坏本地快照的只读行为。断言 CLI stdout/stderr 无合成 code/token；输出仅保留脱敏测试摘要。

报告默认位于 `.cache/dingtalk-g0/exchange-report.json`。HTTP 测试端点和 `DWS_ALLOW_HTTP_ENDPOINTS` 仅用于测试，不能传入生产 LocalBackend。

## 4. 重跑上游官方 smoke

下载单个固定提交的上游测试脚本，无需把 DWS 源码复制进插件：

```powershell
$taskLock = Get-Content dsh-dingtalk/dws.lock.json -Raw | ConvertFrom-Json
Invoke-WebRequest -Uri $taskLock.dws.upstreamSmoke.sourceUrl -OutFile .cache/dingtalk-g0/upstream-smoke.py
python dsh-dingtalk/scripts/g0/run-upstream-smoke.py --source .cache/dingtalk-g0/upstream-smoke.py --binary .cache/dingtalk-g0/bin-amd64/dws.exe --out .cache/dingtalk-g0/upstream-smoke-report.json
```

runner 先核对二进制哈希及上游源码 LF 规范化哈希。只增加每个临时目录的 Windows 测试注册表命名空间和关闭更新检查，不改上游断言；源码形状或哈希变化即拒绝运行。不要在 Windows 直接运行未增加命名空间的上游 smoke，以免其多个临时目录共享默认凭证槽。

6 组上游检查包含默认/显式/省略应用的换票、在线身份、持久化、刷新、普通 get-self（默认和精确 Profile），预演/无效参数无副作用，9 种成功/失败/预演与输入方式组合的脱敏检查，以及缺失在线 userId 的拒绝。

## 5. 官方 DSH 发布包 API 验证

```powershell
npm install --prefix .cache/dingtalk-g0/dsh-runtime --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.1-rc.5
npm install --prefix .cache/dingtalk-g0/slot-runtime --ignore-scripts --omit=optional --no-audit --no-fund --save-exact @deepseek-ai/dsh-client-ui-slots@0.2.1-rc.5
node dsh-dingtalk/scripts/g0/probe-dsh.mjs
```

slots 是客户端编译时依赖，因此单独安装其 Node 核心库进行 registry API 检查。首次安装可能较慢；未启用依赖安装脚本。本步骤不启动完整 Web/Desktop 应用，不验证需额外初始化的可选原生能力。

可通过 `--runtime` 和 `--slot-runtime` 指定两个缓存根目录，使用 `--out` 指定报告。探针只使用真实发布包类和合成工具，在隔离 DSH_HOME 下启动 CLI 版本检查。工具注册 owner 需要声明 `inject: ['tools']`；卸载使用 Cordis fiber 的 dispose。

## 6. 证据与判定

提交的公开 snapshots 和脱敏报告位于 `docs/evidence/g0/`。真实 OAuth code、Token、AppSecret、个人资料、钉钉业务正文、运行日志、官方 CLI 和下载的上游源码均不提交。

报告中的本地 PASS 不能替代真实 G0/G1 验收；企业与浏览器项见 [真实联调清单](G0-enterprise-test-plan.md)。
