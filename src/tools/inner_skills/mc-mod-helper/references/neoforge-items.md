# NeoForge 物品开发参考

## Item.Properties 配置

```java
new Item.Properties()
    .setId(ResourceKey.create(Registries.ITEM, registryName))  // 必须设置
    .stacksTo(64)              // 最大堆叠数（默认64）
    .durability(250)           // 设置耐久度（自动锁定堆叠为1）
    .fireResistant()           // 防火/岩浆（下界合金）
    .rarity(Rarity.RARE)       // 稀有度 COMMON/UNCOMMON/RARE/EPIC
    .food(foodProperties)      // 食物属性
    .enchantable(15)           // 附魔能力
    .repairable(ingredient)    // 修复材料
    .equippable(equipmentSlot) // 可装备到指定槽位
    .jukeboxPlayable(songKey)  // 唱片播放
    .craftRemainder(item)      // 合成残留物（如桶）
    .useCooldown(seconds)      // 使用冷却
```

## 食物属性 FoodProperties
```java
new FoodProperties.Builder()
    .nutrition(4)              // 饱食度
    .saturation(0.3f)          // 饱和度
    .alwaysEat()               // 始终可吃（满饱时也可以）
    .fast()                    // 快速食用
    .effect(effect, chance)    // 食用后效果
    .build();
```

## 物品类型模板

### 基础物品
```java
public static final DeferredItem<Item> RUBY = ITEMS.registerSimpleItem("ruby");
```

### 食物
```java
public static final DeferredItem<Item> CUSTOM_FOOD = ITEMS.registerItem(
    "custom_food",
    props -> props.food(new FoodProperties.Builder().nutrition(6).saturation(0.6f).build()),
    new Item.Properties()
);
```

### 工具
```java
// 工具需要使用自定义 Tier 和对应工具类
public static final DeferredItem<SwordItem> RUBY_SWORD = ITEMS.registerItem(
    "ruby_sword",
    properties -> new SwordItem(ModTiers.RUBY, 3, -2.4f, properties),
    new Item.Properties().durability(500).enchantable(15)
);
```

## 物品模型 JSON
路径: `assets/<modId>/models/item/<item_name>.json`

```json
{
  "parent": "minecraft:item/generated",
  "textures": {
    "layer0": "mod_id:item/ruby"
  }
}
```

手持工具模型使用 `item/handheld` 父模型：
```json
{
  "parent": "minecraft:item/handheld",
  "textures": {
    "layer0": "mod_id:item/ruby_sword"
  }
}
```

## 物品标签
路径: `data/<modId>/tags/item/<tag_name>.json`

```json
{
  "values": [
    "mod_id:ruby",
    "minecraft:diamond"
  ]
}
```

## 客户端物品（Client Items）
路径: `assets/<modId>/items/<item_name>.json`

这是 NeoForge 1.21+ 新增的客户端物品定义，用于描述物品在客户端如何渲染。

```json
{
  "model": {
    "type": "minecraft:model",
    "model": "mod_id:item/ruby"
  }
}
```
