# ADR-0001：以独立 BOOP 页面承载持续助理体验

状态：已接受，并在 `cursor/boop-mvp-v0.2-f3d6` 落地。

## 背景

旧入口把 BOOP 打开成普通 DSH 会话，并要求先选工作区。任务板把账本、门禁和内部 ID 放在首屏。

## 决策

注册自有 `main` 面板 `boop.home`。页头、欢迎态、工作抽屉和设置由 BOOP 拥有。正文和输入使用宿主 `conversation.content` 的 embedded factory，绑定 `boop/ensureHome` 返回的真实 Session。主入口不调用 `openSession`，也不创建 Session。

工程目录、包名和 SQLite 路径保持 `dsh-boop`。对用户显示的名称是「BOBO · 波波」。

## 本次覆盖的旧约束

- 不再把「必须打开普通 Conversation」当作主入口。
- 不再把任务板当作首屏。
- 不再展示记忆初始化三选一。

归属、权限、证据和「用户新指令优先」继续有效。旧 `baseline/` 与 `handoff/` 不改写。

## 代价与边界

底层仍是 DSH 消息与输入。没有第二套聊天编辑器。一次委托只指向一个已有普通会话。全局最多一个派发或执行中的委托。

## 验证

页面注册、草稿引用不自动发送、schema 2 迁移和委托状态机有自动化测试。真实宿主里的自然语言闭环尚未在本环境跑通，见实施台账。
