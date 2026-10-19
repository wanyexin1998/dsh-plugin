# 角色素材（派生自已确认视觉稿）

| 文件 | 来源 | 说明 |
|---|---|---|
| `boop-character-transparent.png` | 由 `baseline/assets/boop-character-approved.png`（白底、无 alpha）经 `tools/png-white-to-alpha.mjs` 泛洪去白得到 | **不是重画**：像素全部来自用户已确认的原图，只加了 alpha 通道 |
| `_preview-dark.png` | 同一母版在深底上的合成预览 | 仅供人眼核对抠图质量，不参与运行 |

生成方式（可复现）：

```bash
node tools/png-white-to-alpha.mjs \
  baseline/assets/boop-character-approved.png \
  assets/character/boop-character-transparent.png \
  assets/character/_preview-dark.png
```

规则：白底只从画布边缘泛洪（近纯白、饱和度极低才判定为背景）；奶白腹面被蓝色身体包住，
永远不会被泛洪波及；原图底部接触阴影按 05 册要求保留为角色的一部分。

原始 PNG 未被修改，仍在 `baseline/assets/` 原样保存。
