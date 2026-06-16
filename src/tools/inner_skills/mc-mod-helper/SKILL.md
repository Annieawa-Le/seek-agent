## 用途

Minecraft 模组开发辅助工具，支持 Forge / Fabric / NeoForge 模组的日常开发。覆盖项目初始化、物品/方块注册代码生成、配方/语言/模型/战利品表等资源文件生成。适用于 Java 模组开发者的日常编码辅助。

### 可用工具

| 工具 | 功能 |
|------|------|
| `mc_project_scaffold` | 生成模组项目骨架代码（主类、注册类、创造模式标签页等），支持三种加载器 |
| `mc_register_item` | 生成物品注册代码 + 物品模型 JSON + 语言文件条目 |
| `mc_register_block` | 生成方块注册代码 + 方块状态/模型/战利品表/语言文件 |
| `mc_gen_recipe` | 生成配方 JSON（合成/熔炼/锻造等 8 种类型） |
| `mc_gen_lang` | 生成或追加多语言文件（en_us / zh_cn 等） |
| `mc_gen_model` | 生成物品/方块模型 JSON 和方块状态 JSON |
| `mc_gen_loot_table` | 生成战利品表 JSON（方块/实体/宝箱/钓鱼等） |

### 典型工作流

**新手开新模组：**
```
mc_project_scaffold → 生成项目骨架
mc_register_item   → 添加自定义物品
mc_register_block  → 添加自定义方块
mc_gen_recipe      → 给物品/方块配合成配方
mc_gen_lang        → 添加中英文翻译
```

**日常增补：**
```
mc_register_item → 加个新物品（自动出模型+翻译）
mc_gen_recipe    → 给新物品配个合成配方
```

### 路径约定

所有工具接受 `outputPath` 参数，建议按以下结构组织：

```
<outputPath>/
  src/main/java/<package>/          ← Java 源代码
  src/main/resources/
    assets/<modId>/                 ← 资源文件
      models/
      textures/
      lang/
    data/<modId>/                   ← 数据文件
      recipes/
      loot_tables/
      advancements/
      tags/
```

各工具会自动在对应子目录下创建文件，你只需传入 `outputPath` 为项目根目录即可。

### 与 Java 版本对应

- **Forge 1.20+** — 使用 `DeferredRegister` 模式
- **Fabric 1.20+** — 使用 `Registry.register` + `FabricItemGroup.builder`
- **NeoForge 1.21+** — 与 Forge 类似，使用 `DeferredRegister` + `NeoForgeRegistries`
