# BOOP 3D（来自资产包 BOOP_3D_Animation_v0.1）

| 文件 | 来源 | 校验 |
|---|---|---|
| `boop.glb` | 资产包 `model/boop.glb` | sha256 `379e9845…b56b`，与包内 MANIFEST 一致 |
| `boop-assistant.js` | 资产包 `src/boop-assistant.js` | 零依赖 WebGL2 播放器，构建时打进客户端 bundle |
| `boop-assistant.d.ts` | 资产包 `src/` | 接口声明 |
| `states/boop-<state>-256.png` | 资产包 `images/` | 五态透明 PNG，WebGL 不可用时的降级图 |

**未修改**：以上文件原样拷贝，未改动一个字节（GLB 哈希已核对）。
**未引入**：`BOOP_3D_Studio.html`（2.4MB 内嵌单文件）与 MP4 预览不进产品包。

服务方式：`src/host/assets.ts` 注册 7 条**精确**只读路由（`/api/boop/…`），白名单表内才可访问，
不经鉴权拿不到（401），ETag 命中返回 304。GLB 1.3MB 首次加载后内存缓存。

播放器接入见 `docs/02_前端接入.md`（资产包内），本仓库实现在 `src/client/companion3d.tsx`。
