# NeoForge 项目结构与配置参考

## gradle.properties
```properties
org.gradle.jvmargs=-Xmx3G
minecraft_version=1.21.1
minecraft_version_range=[1.21.1,1.21.2)
neo_version=21.1.0
mod_id=examplemod
mod_name=Example Mod
mod_license=MIT
mod_version=1.0.0
mod_group_id=com.example.examplemod
```

## neoforge.mods.toml
路径: `src/main/resources/META-INF/neoforge.mods.toml`

```toml
modLoader="javafml"
loaderVersion="[1,)"

[[mods]]
modId="${mod_id}"
version="${mod_version}"
displayName="${mod_name}"
logoFile="logo.png"
credits=""
authors=""
displayURL=""
description='''
This is an example mod.
'''

[[dependencies.${mod_id}]]
    modId="minecraft"
    type="required"
    versionRange="${minecraft_version_range}"
    ordering="NONE"
    side="BOTH"
```

## @Mod 主类
```java
package com.example.examplemod;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;

@Mod(ExampleMod.MOD_ID)
public class ExampleMod {
    public static final String MOD_ID = "examplemod";

    public ExampleMod(IEventBus modBus) {
        // 注册 DeferredRegister
        ModBlocks.BLOCKS.register(modBus);
        ModItems.ITEMS.register(modBus);
        ModCreativeTabs.CREATIVE_MODE_TABS.register(modBus);
    }
}
```

## 推荐的包结构
```
src/main/java/com/example/examplemod/
├── ExampleMod.java                    # @Mod 主类
├── block/                             # 方块类
│   ├── ModBlocks.java                 # 方块注册（DeferredRegister.Blocks）
│   └── custom/
├── item/                              # 物品类
│   ├── ModItems.java                  # 物品注册（DeferredRegister.Items）
│   └── custom/
├── entity/                            # 实体
├── blockentity/                       # 方块实体
├── menu/                              # 菜单容器
├── network/                           # 网络包
├── worldgen/                          # 世界生成
├── data/                              # 数据生成
├── client/                            # 客户端代码
│   └── model/
├── event/                             # 事件监听
└── Config.java                        # 配置
```

## 类命名约定
- 物品: `RubyItem` (后缀 Item)
- 方块: `RubyBlock` (后缀 Block)
- 方块实体: `RubyBlockEntity`
- 菜单: `RubyMenu`
- 容器: `RubyContainer`
- 注册类: `ModBlocks`, `ModItems`, `ModEntities` 等（前缀 Mod）

## modId 规范
- 仅允许小写字母、数字、下划线
- 长度 2-64 个字符
- 作为资源包和数据包命名空间

## 数据生成注册
```java
@SubscribeEvent
public static void gatherData(GatherDataEvent.Client event) {
    event.createProvider(MyRecipeProvider.Runner::new);
    event.createProvider(MyLootTableProvider.Runner::new);
    event.createProvider(MyModelProvider::new);
    event.createProvider(MyLanguageProvider::new);
}
```
