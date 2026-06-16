# NeoForge 资源文件格式参考

## 语言文件
路径: `assets/<modId>/lang/<locale>.json`

```json
{
  "item.mod_id.ruby": "Ruby",
  "block.mod_id.ruby_block": "Ruby Block",
  "block.mod_id.ruby_ore": "Ruby Ore",
  "itemGroup.mod_id.example": "Example Tab",
  "entity.mod_id.ruby_golem": "Ruby Golem",
  "enchantment.mod_id.ruby_power": "Ruby Power",
  "effect.mod_id.ruby_effect": "Ruby Effect",
  "key.category.mod_id": "Example Mod",
  "key.mod_id.special": "Special Ability"
}
```

### 翻译键约定
- 物品: `item.<modId>.<registry_name>`
- 方块: `block.<modId>.<registry_name>`
- 标签页: `itemGroup.<modId>.<tab_name>` 或 `creative_tab.<modId>.<tab_name>`
- 实体: `entity.<modId>.<registry_name>`
- 附魔: `enchantment.<modId>.<registry_name>`
- 效果: `effect.<modId>.<registry_name>`
- 按键绑定分类: `key.category.<modId>`
- 按键绑定: `key.<modId>.<name>`

## 配方 JSON
路径: `data/<modId>/recipe/<recipe_name>.json`

### 有序合成（Shaped）
```json
{
  "type": "minecraft:crafting_shaped",
  "pattern": [
    "###",
    "#X#",
    "###"
  ],
  "key": {
    "#": { "item": "minecraft:stone" },
    "X": { "item": "mod_id:ruby" }
  },
  "result": {
    "id": "mod_id:ruby_block",
    "count": 1
  }
}
```

### 无序合成（Shapeless）
```json
{
  "type": "minecraft:crafting_shapeless",
  "ingredients": [
    { "item": "mod_id:ruby" },
    { "item": "mod_id:ruby" },
    { "item": "mod_id:ruby" },
    { "item": "mod_id:ruby" }
  ],
  "result": {
    "id": "minecraft:diamond",
    "count": 4
  }
}
```

### 熔炼（Smelting）
```json
{
  "type": "minecraft:smelting",
  "ingredient": { "item": "mod_id:raw_ruby" },
  "result": { "id": "mod_id:ruby" },
  "experience": 0.7,
  "cookingtime": 200
}
```

### 高炉 / 烟熏炉
```json
{
  "type": "minecraft:blasting",
  "ingredient": { "item": "mod_id:raw_ruby" },
  "result": { "id": "mod_id:ruby" },
  "experience": 0.7,
  "cookingtime": 100
}
```

### 切石机（Stonecutting）
```json
{
  "type": "minecraft:stonecutting",
  "ingredient": { "item": "mod_id:ruby_block" },
  "result": { "id": "mod_id:ruby_slab", "count": 2 }
}
```

### 锻造（Smithing）
```json
{
  "type": "minecraft:smithing_transform",
  "addition": { "item": "mod_id:ruby" },
  "base": { "item": "minecraft:diamond_sword" },
  "result": { "id": "mod_id:ruby_sword" },
  "template": { "item": "minecraft:netherite_upgrade_smithing_template" }
}
```

### 营火烹饪
```json
{
  "type": "minecraft:campfire_cooking",
  "ingredient": { "item": "mod_id:raw_ruby" },
  "result": { "id": "mod_id:ruby" },
  "experience": 0.35,
  "cookingtime": 600
}
```

## 战利品表 JSON
路径: `data/<modId>/loot_table/blocks/<block_name>.json`

### 方块掉落自身
```json
{
  "type": "minecraft:block",
  "pools": [
    {
      "rolls": 1,
      "entries": [
        {
          "type": "minecraft:item",
          "name": "mod_id:ruby_block"
        }
      ],
      "conditions": [
        {
          "condition": "minecraft:survives_explosion"
        }
      ]
    }
  ]
}
```

### 矿石掉落（带经验）
```json
{
  "type": "minecraft:block",
  "pools": [
    {
      "rolls": 1,
      "entries": [
        {
          "type": "minecraft:item",
          "name": "mod_id:ruby",
          "functions": [
            {
              "function": "minecraft:apply_bonus",
              "enchantment": "minecraft:fortune",
              "formula": "minecraft:ore_drops"
            }
          ]
        }
      ],
      "conditions": [
        {
          "condition": "minecraft:survives_explosion"
        }
      ]
    }
  ]
}
```

### 多重战利品
```json
{
  "type": "minecraft:block",
  "pools": [
    {
      "rolls": 1,
      "entries": [
        { "type": "minecraft:item", "name": "mod_id:ruby_block" }
      ]
    }
  ]
}
```

## 模型 JSON

### 物品模型
`assets/<modId>/models/item/<name>.json`

```json
{
  "parent": "minecraft:item/generated",
  "textures": {
    "layer0": "mod_id:item/ruby"
  }
}
```

### 手持/工具模型
```json
{
  "parent": "minecraft:item/handheld",
  "textures": {
    "layer0": "mod_id:item/ruby_sword"
  }
}
```

### 简单方块模型（cube_all）
```json
{
  "parent": "minecraft:block/cube_all",
  "textures": {
    "all": "mod_id:block/ruby_block"
  }
}
```

### 多纹理方块
```json
{
  "parent": "minecraft:block/cube_bottom_top",
  "textures": {
    "bottom": "mod_id:block/ruby_block_bottom",
    "top": "mod_id:block/ruby_block_top",
    "side": "mod_id:block/ruby_block_side"
  }
}
```

### 定向方块（侧面不同）
```json
{
  "parent": "minecraft:block/orientable",
  "textures": {
    "front": "mod_id:block/ruby_front",
    "side": "mod_id:block/ruby_side",
    "top": "mod_id:block/ruby_top"
  }
}
```

### 植物/横截面
```json
{
  "parent": "minecraft:block/cross",
  "textures": {
    "cross": "mod_id:block/ruby_flower"
  }
}
```

## 纹理路径约定
- 物品纹理: `assets/<modId>/textures/item/<name>.png`
- 方块纹理: `assets/<modId>/textures/block/<name>.png`
- 模型 JSON 中引用: `mod_id:item/<name>` 或 `mod_id:block/<name>`

## 文件夹结构总览
```
src/main/resources/
├── META-INF/
│   └── neoforge.mods.toml
├── assets/<modId>/
│   ├── blockstates/
│   │   └── <block>.json
│   ├── items/
│   │   └── <item>.json        (客户端的物品定义)
│   ├── lang/
│   │   ├── en_us.json
│   │   └── zh_cn.json
│   ├── models/
│   │   ├── block/
│   │   │   └── <block>.json
│   │   └── item/
│   │       └── <item>.json
│   └── textures/
│       ├── block/
│       │   └── <block>.png
│       └── item/
│           └── <item>.png
└── data/<modId>/
    ├── recipe/
    │   └── <recipe>.json
    ├── loot_table/
    │   └── blocks/
    │       └── <block>.json
    ├── tags/
    │   ├── block/
    │   │   └── <tag>.json
    │   └── item/
    │       └── <tag>.json
    └── advancement/
        └── <advancement>.json
```
