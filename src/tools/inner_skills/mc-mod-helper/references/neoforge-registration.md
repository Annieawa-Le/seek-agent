# NeoForge 注册系统参考

## DeferredRegister 基础模式

```java
// 创建 DeferredRegister
public static final DeferredRegister<Block> BLOCKS = DeferredRegister.create(
    BuiltInRegistries.BLOCK, ExampleMod.MOD_ID
);

// 注册条目（返回 DeferredHolder）
public static final DeferredHolder<Block, Block> EXAMPLE_BLOCK = BLOCKS.register(
    "example_block",
    () -> new Block(BlockBehaviour.Properties.of())
);

// 使用 Supplier 简化
public static final Supplier<Block> EXAMPLE_BLOCK = BLOCKS.register(
    "example_block",
    () -> new Block(BlockBehaviour.Properties.of())
);

// 带 registryName 参数的工厂
public static final Supplier<SlabBlock> EXAMPLE_SLAB = BLOCKS.register(
    "example_slab",
    registryName -> new SlabBlock(...)
);

// 在 mod 构造函数中注册
public ExampleMod(IEventBus modBus) {
    ExampleBlocksClass.BLOCKS.register(modBus);
}
```

## 专用 DeferredRegister 变体

### DeferredRegister.Blocks
```java
public static final DeferredRegister.Blocks BLOCKS = DeferredRegister.createBlocks(MOD_ID);

// 返回 DeferredBlock<T>
public static final DeferredBlock<Block> MY_BLOCK = BLOCKS.register(
    "my_block", registryName -> new Block(...)
);

// registerBlock - 分离工厂和属性
public static final DeferredBlock<Block> MY_BLOCK = BLOCKS.registerBlock(
    "my_block",
    Block::new,
    () -> BlockBehaviour.Properties.of()
);

// registerSimpleBlock - 省略工厂（使用 Block::new）
public static final DeferredBlock<Block> MY_BLOCK = BLOCKS.registerSimpleBlock(
    "my_block",
    () -> BlockBehaviour.Properties.of()
);
```

### DeferredRegister.Items
```java
public static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(MOD_ID);

// registerItem - 带工厂
public static final DeferredItem<Item> EXAMPLE_ITEM = ITEMS.registerItem(
    "example_item",
    Item::new,
    props -> props
);

// registerSimpleItem - 省略工厂
public static final DeferredItem<Item> EXAMPLE_ITEM = ITEMS.registerSimpleItem(
    "example_item",
    props -> props
);

// 最简单形式
public static final DeferredItem<Item> EXAMPLE_ITEM = ITEMS.registerSimpleItem("example_item");

// BlockItem 快捷方法
public static final DeferredItem<BlockItem> EXAMPLE_BLOCK_ITEM = ITEMS.registerSimpleBlockItem(
    "example_block",
    ExampleBlocksClass.EXAMPLE_BLOCK
);
```

## RegisterEvent 方式（替代方案）
```java
@SubscribeEvent
public static void register(RegisterEvent event) {
    event.register(BuiltInRegistries.BLOCK, registry -> {
        registry.register(
            Identifier.fromNamespaceAndPath(MODID, "example_block"),
            new Block(...)
        );
    });
}
```

## 查询注册表
```java
BuiltInRegistries.BLOCK.getValue(Identifier.fromNamespaceAndPath("minecraft", "dirt"));
BuiltInRegistries.BLOCK.getKey(Blocks.DIRT); // "minecraft:dirt"
BuiltInRegistries.BLOCK.containsKey(Identifier.fromNamespaceAndPath("modid", "item"));
```

## 创造模式标签页

### 添加到已有标签页
```java
@SubscribeEvent
public static void buildContents(BuildCreativeModeTabContentsEvent event) {
    if (event.getTabKey() == CreativeModeTabs.INGREDIENTS) {
        event.accept(MyItemsClass.MY_ITEM.get());
        event.accept(MyBlocksClass.MY_BLOCK.get());
    }
}
```

### 自定义标签页
```java
public static final Supplier<CreativeModeTab> EXAMPLE_TAB = CREATIVE_MODE_TABS.register(
    "example", () -> CreativeModeTab.builder()
        .title(Component.translatable("itemGroup." + MOD_ID + ".example"))
        .icon(() -> new ItemStack(MyItemsClass.EXAMPLE_ITEM.get()))
        .displayItems((params, output) -> {
            output.accept(MyItemsClass.MY_ITEM.get());
            output.accept(MyBlocksClass.MY_BLOCK.get());
        })
        .build()
);
```

## 注册表键（RegistryKey）
```java
// 方块 ID 必须在 BlockBehaviour.Properties 中设置
ResourceKey.create(Registries.BLOCK, Identifier.fromNamespaceAndPath(modId, "block_name"))
ResourceKey.create(Registries.ITEM, Identifier.fromNamespaceAndPath(modId, "item_name"))
```

## 关键区别：Forge vs NeoForge
- NeoForge 使用 `BuiltInRegistries` 而非 `ForgeRegistries`
- NeoForge 注册表键使用 `ResourceKey.create()` + `Identifier.fromNamespaceAndPath()`
- `DeferredRegister.Blocks` 和 `DeferredRegister.Items` 是 NeoForge 特有
- 属性必须调用 `.setId()` 或使用 `registerBlock/registerItem` 自动设置
