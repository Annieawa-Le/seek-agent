# mc-mod-helper — 提示词注入

## 使用偏好

1. **优先使用 `mc_project_scaffold` 初始化项目**，再逐个调用其他工具添加内容。
2. **生成代码时遵循对应加载器的官方最佳实践**：
   - Forge 1.20+ → `DeferredRegister` 模式
   - Fabric → `Registry.register` + `FabricItemGroup.builder`
   - NeoForge 1.21+ → `DeferredRegister` + `NeoForgeRegistries`
3. **语言文件优先同时生成 `en_us` 和 `zh_cn`**，英文用原名字面翻译，中文用直观中文名。
4. **配方 JSON 使用 Minecraft 原版命名空间**，除非模组引用了其他模组的物品。
5. **调用工具前**，如果用户未提供 `outputPath`，询问用户的项目根目录路径。
6. **模型纹理路径默认使用 `mod_id:block/xxx` 和 `mod_id:item/xxx`** 约定。

## 与其它技能配合

- 与 `code-reader` 配合分析现有模组代码结构
- 与 `virtual-explorer` 配合浏览项目目录结构
- 与 `gh-explorer` 配合从 GitHub 拉取模组示例或模板
