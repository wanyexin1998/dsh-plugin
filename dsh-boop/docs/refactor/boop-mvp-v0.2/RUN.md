# 在本分支上构建、安装和验收

开发起点是远端 `main` 的 `6f9c046681e58a1304704baf165dce5de2a49f4f`。包版本是 `0.2.0`。不要把本分支合并或部署。

## 构建

```bash
cd dsh-boop
node -v          # 需要 ^22.19 或 >=24
pnpm install     # 已有 lockfile 时不要删锁重解
node build.mjs
node --test tests/unit/*.test.mjs tests/client/mvp-home-lifecycle.test.mjs tests/client/e04-01b-client-apply.test.mjs
```

`node build.mjs` 生成 `lib/`。`lib/` 被构建消费，不作为手改源码。

客户端测试 `e04-01b-client-apply` 读取 `lib/client.js`，要先构建。

## 安装到隔离的 DSH

不要把插件装进正在使用的桌面 profile，也不要打开用户原来的 `$DSH_HOME/boop/boop.sqlite`。

```bash
export DSH_HOME=/tmp/boop-mvp-dsh
export DSH_NODE="$(command -v node)"
# 需要本机已有的 DSH web 模板。没有模板时这一步会失败，不能改用别人的 Windows 路径。
dsh --profile boopmvp --from-default-profile web --dump-config
# 然后把 dsh-boop 以 link: 加进该隔离 profile，再：
dsh --profile boopmvp web --no-open --host 127.0.0.1 --port 8787
```

桌面验收需要 `DSH_DESKTOP_EXE`。本云端没有 Windows 桌面，不能代替那一项。

从源码包提取测试宿主时还需要 `DSH_ASAR` 和 `DSH_UNPACKED`。没有这些变量时工具会直接退出，不再指向个人机器路径。

## 打开后怎么看

1. 左侧入口应写「BOOP · 波波」，点开后是 BOOP 自己的页头，而不是普通新会话。
2. 没有模型时，页面说明去 DSH 设置里连接模型。连接之后可以直接聊天。
3. 工作抽屉里的停止、确认收下和继续处理走 `boopTasks/stop`、`boopTasks/confirm` 和主聊天草稿。确认收下不会把失败的检查改成通过。
4. 打开原会话才会离开 BOOP，并调用普通 `openSession`。

页面结构截图在 `docs/refactor/boop-mvp-v0.2/evidence/screenshots/`。那是真实组件的渲染，输入区在正式宿主里由 `conversation.content` 提供。截图里的输入条只标出这个位置。

## 数据

升级会先做 SQLite 一致备份，再把 schema 1 迁到 2。备份目录是账本旁边的 `backups/`。没有备份目录时升级会拒绝并保持旧版本。回滚是停掉写入方，再用当时的备份和对应旧包恢复，不是把 `schema_version` 改回 1。
