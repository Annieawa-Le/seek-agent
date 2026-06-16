# NeoForge 方块开发参考

## BlockBehaviour.Properties 配置

```java
BlockBehaviour.Properties.of()
    .setId(ResourceKey.create(Registries.BLOCK, registryName))  // 必须设置
    .destroyTime(1.5f)          // 破坏时间（石头1.5，泥土0.5，黑曜石50，基岩-1不可破坏）
    .explosionResistance(6.0f)  // 爆炸抗性（石头6.0，泥土0.5，黑曜石1200）
    .sound(SoundType.STONE)     // 声音类型
    .lightLevel(state -> 7)     // 光照等级 0-15
    .friction(0.6f)             // 摩擦系数（冰0.98）
    .noOcclusion()              // 不遮挡（如植物）
    .requiresCorrectToolForDrops() // 需要正确工具才能掉落
    .randomTicks()              // 启用随机刻
    .mapColor(MapColor.STONE)   // 地图颜色
    .instrument(NoteBlockInstrument.BASS) // 音符盒音色
    .pushState(PushReaction.BLOCK) // 活塞推动行为
    .replaceable()              // 可被替换（如草）
    .noCollission()             // 无碰撞箱
    .dynamicShape()             // 动态碰撞箱形状
```

## 方块类型模板

### 基础方块
```java
public static final DeferredBlock<Block> RUBY_BLOCK = BLOCKS.registerSimpleBlock(
    "ruby_block",
    BlockBehaviour.Properties.of()
        .destroyTime(5.0f)
        .explosionResistance(6.0f)
        .sound(SoundType.STONE)
        .requiresCorrectToolForDrops()
);
```

### 矿石
```java
public static final DeferredBlock<Block> RUBY_ORE = BLOCKS.registerSimpleBlock(
    "ruby_ore",
    BlockBehaviour.Properties.of()
        .destroyTime(3.0f)
        .explosionResistance(3.0f)
        .sound(SoundType.STONE)
        .requiresCorrectToolForDrops()
);
```

### 楼梯
```java
// 需要自定义类
public static final DeferredBlock<StairBlock> RUBY_STAIRS = BLOCKS.registerBlock(
    "ruby_stairs",
    StairBlock::new,
    BlockBehaviour.Properties.of()
        .destroyTime(5.0f)
        .explosionResistance(6.0f)
        .sound(SoundType.STONE)
        .requiresCorrectToolForDrops()
);
```

### 台阶
```java
public static final DeferredBlock<SlabBlock> RUBY_SLAB = BLOCKS.registerBlock(
    "ruby_slab",
    SlabBlock::new,
    BlockBehaviour.Properties.of()
        .destroyTime(5.0f)
        .explosionResistance(6.0f)
        .sound(SoundType.STONE)
        .requiresCorrectToolForDrops()
);
```

### 栅栏
```java
public static final DeferredBlock<FenceBlock> RUBY_FENCE = BLOCKS.registerBlock(
    "ruby_fence",
    FenceBlock::new,
    BlockBehaviour.Properties.of()
        .destroyTime(5.0f)
        .explosionResistance(6.0f)
        .sound(SoundType.STONE)
);
```

### 墙
```java
public static final DeferredBlock<WallBlock> RUBY_WALL = BLOCKS.registerBlock(
    "ruby_wall",
    WallBlock::new,
    BlockBehaviour.Properties.of()
        .destroyTime(5.0f)
        .explosionResistance(6.0f)
        .sound(SoundType.STONE)
);
```

### 门 / 活板门
```java
public static final DeferredBlock<DoorBlock> RUBY_DOOR = BLOCKS.registerBlock(
    "ruby_door",
    DoorBlock::new,
    BlockBehaviour.Properties.of()
        .destroyTime(5.0f)
        .sound(SoundType.WOOD)
        .noOcclusion()
);

public static final DeferredBlock<TrapDoorBlock> RUBY_TRAPDOOR = BLOCKS.registerBlock(
    "ruby_trapdoor",
    TrapDoorBlock::new,
    BlockBehaviour.Properties.of()
        .destroyTime(5.0f)
        .sound(SoundType.WOOD)
        .noOcclusion()
);
```

## 方块状态 JSON
路径: `assets/<modId>/blockstates/<block_name>.json`

```json
{
  "variants": {
    "": {
      "model": "mod_id:block/ruby_block"
    }
  }
}
```

有方向的方块：
```json
{
  "variants": {
    "facing=north": { "model": "mod_id:block/ruby_block" },
    "facing=south": { "model": "mod_id:block/ruby_block", "y": 180 },
    "facing=east":  { "model": "mod_id:block/ruby_block", "y": 90 },
    "facing=west":  { "model": "mod_id:block/ruby_block", "y": 270 }
  }
}
```

## 方块模型 JSON
路径: `assets/<modId>/models/block/<block_name>.json`

```json
{
  "parent": "minecraft:block/cube_all",
  "textures": {
    "all": "mod_id:block/ruby_block"
  }
}
```

## BlockItem
方块必须对应注册一个 BlockItem 才能在背包中存在：
```java
public static final DeferredItem<BlockItem> RUBY_BLOCK_ITEM = ITEMS.registerSimpleBlockItem(
    "ruby_block",
    ModBlocks.RUBY_BLOCK
);
```
