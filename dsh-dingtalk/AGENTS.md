# 开发约束

- 本目录是 `wanyexin1998/dsh-plugin` 的普通插件目录，不使用子模块或嵌套 Git。只构建 `@wanyexin1998/dsh-dingtalk`（未经用户要求不发布），不拆分公共 SDK。
- 第一版只适配最新版 DeepSeek Harness 的 `web` profile。
- 使用 Node.js `^22.19.0 || >=24.0.0` 与 pnpm 11；提交前运行 `pnpm run ci`。
- 不得提交真实 Client Secret、二维码、绑定口令、用户消息、内部地址或内网仓库内容。
- `setup`、`doctor`、消息桥接和 NPM tarball 是稳定的行为边界；变更这些行为时应先补测试。
- 不添加 GitHub Actions。所有构建、测试、包校验在本地完成；`ci` 是本地检查命令。
- 本地验收后推送新分支，通过 PR 合并主分支。包保持 private，不执行 NPM 发布。
- 独立 fork 的 main 仅跟踪官方。上游更新通过差异审查迁入本目录，不能覆盖 enhancements 或直接整目录同步。详见 docs/REPOSITORY.md。
