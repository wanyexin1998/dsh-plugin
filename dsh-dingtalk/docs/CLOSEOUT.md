# 2026-11-03 迁移收尾记录

## 本地完成

- 大仓库新分支：`feat/dingtalk-official-monorepo`，从 `dsh-plugin/main@6f9c046` 建立。只新增钉钉插件目录及历史方案说明；不改其他插件。
- 官方跟踪目录已回到 `main@137ea79505e6317d98c1db643f0fbae138e016c8`；定制内容备份在 `archive/custom-web-20261103@e05c9fb102cab22d86a14bf1e688bb2b57310d66`。原功能分支保留。
- 迁入全部定制功能、测试、文档、许可证和固定 DWS 目录。排除上游 `.github` 管理文件，不创建 Actions。
- 修复全新检出时类型检查依赖旧生成文件的问题；包元数据改为大仓库子目录，包名和导出不变。
- 预览运行数据移到 `%LOCALAPPDATA%\dsh-dt`，使用短路径避免 Windows 下 pnpm 链接解析失败。按新 Profile 路径重算状态目录名，保留授权、会话和配置。
- 预览服务：`http://127.0.0.1:19877`。已安装大仓库 tarball，关键运行文件与本地构建一致；未认证访问返回 401，启动脚本通过宿主原生入口打开浏览器。无需手填 JSON。
- 原开发源码、构建产物及运行数据保留于本机忽略缓存中；未提交凭据或运行数据。

## 本地验证

- 干净目录依赖安装：`pnpm install --frozen-lockfile` 通过。
- `pnpm run ci` 通过：敏感内容扫描、格式、TypeScript、基础测试 334 通过 / 51 条件跳过、Web 测试 50 通过、tarball 边界检查通过。
- `pnpm run verify:browser` 通过：明暗主题、窄屏、对齐、加载动画、原位授权状态及回复尾部提示。
- 实际 DSH `0.2.1-rc.5` 安装与 Web 启动通过；无改动宿主源码。最后的公网授权入口发现请求返回 `service_unavailable`，该项未通过，需恢复网络后重跑 `npm run verify:dsh-web`。
- 本次没有将真实企业全部业务、真实机器人私聊/群聊或跨入口身份一致性记为验收通过。

本机详细日志位于大仓库 `.cache/migration-20261103/`，不随源码提交。

## 远程待完成

本轮 GitHub API、Git HTTPS 及连接器出现网络/TLS 连接失败，尚未修改远程设置、推送分支、创建或合并 PR。执行顺序保持如下，不跳过本地收尾：

1. 恢复网络，补验公网授权入口。
2. 确认并关闭 `wanyexin1998/dsh-plugin` 与 `wanyexin1998/dsh-dingtalk` 的 Actions。
3. 推送 fork 的备份分支；fork main 继续跟踪官方，不合入定制改动。
4. 推送大仓库新分支，创建 PR，检查最终差异及准确 head SHA 后合并 main。
5. 将本地 main 快进到合并结果，更新本记录的远程状态。不得发布 NPM。
