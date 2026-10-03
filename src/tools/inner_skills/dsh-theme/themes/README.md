# themes —— 已安装的皮肤包

每个子目录是一个皮肤包（`skin.json` + `skin.css` + `skin.js` [+ `assets/`]），
目录名即皮肤目录，`skin.json` 的 `id` 可与目录名不同（宿主两个都认）。

## 已装清单

| 目录 | 名称 | 契约世代 | 来源 |
|---|---|---|---|
| `roxy-celestial-library` | 洛琪希·星穹水神书库 | DSH 0.1.x | mingdaok/deep-Roxy-Migurdia（第三方皮肤，自带素材） |
| `blue-fantasy` | 蓝色幻想 | DSH 0.2.x | dsh-web-ui 系列 |
| `dragon-heir` | 龙的传人 | DSH 0.2.x | dsh-web-ui 系列 |
| `maid-atelier` | 深海女仆工坊 | DSH 0.2.x | dsh-web-ui 系列（CC BY-NC-SA 4.0，非商业） |
| `miku` | 初音未来 · 电子歌姬 | DSH 0.2.x | dsh-web-ui 系列 |
| `minecraft` | Minecraft 方块世界 | DSH 0.2.x | dsh-web-ui 系列 |
| `qq98` | QQ2008 怀旧版 | DSH 0.2.x | dsh-web-ui 系列 |
| `ths` | 同花顺风格 | DSH 0.2.x | dsh-web-ui 系列 |
| `trading` | 交易终端 | DSH 0.2.x | dsh-web-ui 系列 |
| `whale-song` | 鲸吟 | DSH 0.2.x | dsh-web-ui 系列 |
| `xp` | Windows XP (Luna) | DSH 0.2.x | dsh-web-ui 系列 |

10 款 dsh-web-ui 系列皮肤的观感内容版权归原作者（BSD-3-Clause © zhu1090093659，
`maid-atelier` 为 CC BY-NC-SA 4.0）；逐包的包名、许可与上游仓库见各自 `skin.json` 的
`author` / `license` / `source` / `upstream` 字段。

## 重新导入

这批皮肤由 EAC 主仓（DSH-Desktop-EAC）内置分发、上游 npm 包为
`@linxin666/dsh-client-ui-skin-*`。重新导入（例如上游发新版）用随包导入器：

```bash
# 源目录下每个子目录应含 skin.json + lib/client.js（DSH 的 __ModuleLoader__ bundle）
node ../tools/import-dsh-skins.mjs <源目录> [皮肤 id...] [--verify]
```

导入是机械的：CSS 原样抽出成 `skin.css`，工厂体原样保留进 `skin.js`（末尾接一层适配层导出
`apply`）。DSH 与 seek-agent 的结构差异由加载器的 CSS 适配与转义层在运行时兜底，
皮肤本体不做任何改写。

## 契约差异备忘

- **根节点**：DSH 0.2 皮肤写 `[id=root]`，宿主根是 `#app` —— 加载器在注入前做等价替换
  （`adaptDshSelectors`），特异性不变。
- **三列**：DSH 0.2 用 `[data-pane=sidebar|conversation|details]` 定位列，转义层负责补这三个钩子。
- **不可命中的部分**：`.aionui-*`（DSH 的文件浏览 / 预览列组件）、`[data-gitgraph-*]`（DSH 的 Git
  图面板）在 seek-agent 里没有对应结构，这批规则整体落空 —— 表现为对应局部无皮肤化，不影响其余部分。
- **单色 / 双色**：dsh-web-ui 系列都自带亮暗两套（按 `body[data-ds-dark-theme]` 分支），
  故 `skin.json` 不声明 `colorScheme`；`roxy-celestial-library` 只有暗色，声明了 `"dark"`。
