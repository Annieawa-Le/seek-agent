import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toPascalCase(name: string): string {
  return name.split('_').map(capitalize).join('');
}

const loaderTemplates: Record<string, {
  modAnnotation: string;
  registryImport: string;
  blockRegisterApi: string;
  itemRegisterApi: string;
  creativeTabApi: string;
  itemRegistryClass: string;
  blockRegistryClass: string;
  creativeTabClass: string;
  mainModClass: string;
  neoforgeModsToml: string;
  gradleProps: string;
}> = {
  neoforge: {
    modAnnotation: '@Mod',
    registryImport: `import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.registries.DeferredRegister;`,
    blockRegisterApi: `import net.neoforged.neoforge.registries.DeferredRegister;
import net.neoforged.neoforge.registries.DeferredBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;`,
    itemRegisterApi: `import net.neoforged.neoforge.registries.DeferredRegister;
import net.neoforged.neoforge.registries.DeferredItem;
import net.minecraft.world.item.Item;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;`,
    creativeTabApi: `import net.neoforged.neoforge.registries.DeferredRegister;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.ItemStack;
import java.util.function.Supplier;`,
    mainModClass: (pkg: string, modId: string, modName: string) => `package ${pkg};

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;

@Mod(${toPascalCase(modId)}Mod.MOD_ID)
public class ${toPascalCase(modId)}Mod {
    public static final String MOD_ID = "${modId}";
    public static final String MOD_NAME = "${modName}";

    public ${toPascalCase(modId)}Mod(IEventBus modBus) {
        ModBlocks.BLOCKS.register(modBus);
        ModItems.ITEMS.register(modBus);
        ModCreativeTabs.CREATIVE_MODE_TABS.register(modBus);
    }
}`,
    itemRegistryClass: (pkg: string, modId: string) => `package ${pkg};

import net.neoforged.neoforge.registries.DeferredRegister;
import net.neoforged.neoforge.registries.DeferredItem;
import net.minecraft.world.item.Item;
import net.minecraft.core.registries.Registries;

public class ModItems {
    public static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(${toPascalCase(modId)}Mod.MOD_ID);

    // 在此注册物品，例如：
    // public static final DeferredItem<Item> EXAMPLE_ITEM = ITEMS.registerSimpleItem("example_item");
}`,
    blockRegistryClass: (pkg: string, modId: string) => `package ${pkg};

import net.neoforged.neoforge.registries.DeferredRegister;
import net.neoforged.neoforge.registries.DeferredBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.core.registries.Registries;

public class ModBlocks {
    public static final DeferredRegister.Blocks BLOCKS = DeferredRegister.createBlocks(${toPascalCase(modId)}Mod.MOD_ID);

    // 在此注册方块，例如：
    // public static final DeferredBlock<Block> EXAMPLE_BLOCK = BLOCKS.registerSimpleBlock("example_block",
    //     BlockBehaviour.Properties.of());
}`,
    creativeTabClass: (pkg: string, modId: string) => `package ${pkg};

import net.neoforged.neoforge.registries.DeferredRegister;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.ItemStack;
import java.util.function.Supplier;

public class ModCreativeTabs {
    public static final DeferredRegister<CreativeModeTab> CREATIVE_MODE_TABS =
        DeferredRegister.create(Registries.CREATIVE_MODE_TAB, ${toPascalCase(modId)}Mod.MOD_ID);

    public static final Supplier<CreativeModeTab> ${toPascalCase(modId)}_TAB = CREATIVE_MODE_TABS.register(
        "${modId}_tab",
        () -> CreativeModeTab.builder()
            .title(Component.translatable("itemGroup.${modId}"))
            .icon(() -> new ItemStack(/*ModItems.EXAMPLE_ITEM.get()*/))
            .displayItems((params, output) -> {
                // output.accept(ModItems.EXAMPLE_ITEM.get());
                // output.accept(ModBlocks.EXAMPLE_BLOCK.get());
            })
            .build()
    );
}`,
    neoforgeModsToml: (modId: string, modName: string) => `modLoader="javafml"
loaderVersion="[1,)"

[[mods]]
modId="${modId}"
version="\${file.jarVersion}"
displayName="${modName}"
logoFile=""
credits=""
authors=""
displayURL=""
description='''
${modName} - a Minecraft mod.
'''

[[dependencies.${modId}]]
    modId="minecraft"
    type="required"
    versionRange="[1.21,)"
    ordering="NONE"
    side="BOTH"`,
    gradleProps: (modId: string, modName: string, pkg: string) => `org.gradle.jvmargs=-Xmx3G
minecraft_version=1.21.1
neo_version=21.1.0
mod_id=${modId}
mod_name=${modName}
mod_license=MIT
mod_version=1.0.0
mod_group_id=${pkg}`,
  },
  forge: {
    modAnnotation: '@Mod',
    registryImport: `import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.registries.DeferredRegister;`,
    blockRegisterApi: `import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.RegistryObject;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.core.registries.Registries;`,
    itemRegisterApi: `import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.RegistryObject;
import net.minecraft.world.item.Item;
import net.minecraft.core.registries.Registries;`,
    creativeTabApi: `import net.minecraftforge.registries.DeferredRegister;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.ItemStack;
import java.util.function.Supplier;`,
    mainModClass: (pkg: string, modId: string, modName: string) => `package ${pkg};

import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.common.Mod;

@Mod(${toPascalCase(modId)}Mod.MOD_ID)
public class ${toPascalCase(modId)}Mod {
    public static final String MOD_ID = "${modId}";
    public static final String MOD_NAME = "${modName}";

    public ${toPascalCase(modId)}Mod(IEventBus modBus) {
        ModBlocks.BLOCKS.register(modBus);
        ModItems.ITEMS.register(modBus);
        ModCreativeTabs.CREATIVE_MODE_TABS.register(modBus);
    }
}`,
    itemRegistryClass: (pkg: string, modId: string) => `package ${pkg};

import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.RegistryObject;
import net.minecraft.world.item.Item;
import net.minecraft.core.registries.Registries;

public class ModItems {
    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(Registries.ITEM, ${toPascalCase(modId)}Mod.MOD_ID);

    // 在此注册物品，例如：
    // public static final RegistryObject<Item> EXAMPLE_ITEM = ITEMS.register("example_item",
    //     () -> new Item(new Item.Properties()));
}`,
    blockRegistryClass: (pkg: string, modId: string) => `package ${pkg};

import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.RegistryObject;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.core.registries.Registries;

public class ModBlocks {
    public static final DeferredRegister<Block> BLOCKS = DeferredRegister.create(Registries.BLOCK, ${toPascalCase(modId)}Mod.MOD_ID);

    // 在此注册方块，例如：
    // public static final RegistryObject<Block> EXAMPLE_BLOCK = BLOCKS.register("example_block",
    //     () -> new Block(BlockBehaviour.Properties.of()));
}`,
    creativeTabClass: (pkg: string, modId: string) => `package ${pkg};

import net.minecraftforge.registries.DeferredRegister;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.ItemStack;
import java.util.function.Supplier;

public class ModCreativeTabs {
    public static final DeferredRegister<CreativeModeTab> CREATIVE_MODE_TABS =
        DeferredRegister.create(Registries.CREATIVE_MODE_TAB, ${toPascalCase(modId)}Mod.MOD_ID);

    public static final Supplier<CreativeModeTab> ${toPascalCase(modId)}_TAB = CREATIVE_MODE_TABS.register(
        "${modId}_tab",
        () -> CreativeModeTab.builder()
            .title(Component.translatable("itemGroup.${modId}"))
            .icon(() -> new ItemStack(/*ModItems.EXAMPLE_ITEM.get()*/))
            .displayItems((params, output) -> {
                // output.accept(ModItems.EXAMPLE_ITEM.get());
                // output.accept(ModBlocks.EXAMPLE_BLOCK.get());
            })
            .build()
    );
}`,
    neoforgeModsToml: (modId: string, modName: string) => `modLoader="javafml"
loaderVersion="[1,)"

[[mods]]
modId="${modId}"
version="\${file.jarVersion}"
displayName="${modName}"
logoFile=""
credits=""
authors=""
displayURL=""
description='''
${modName} - a Minecraft mod.
'''

[[dependencies.${modId}]]
    modId="minecraft"
    type="required"
    versionRange="[1.20.1,)"
    ordering="NONE"
    side="BOTH"`,
    gradleProps: (modId: string, modName: string, pkg: string) => `org.gradle.jvmargs=-Xmx3G
minecraft_version=1.20.1
forge_version=47.2.0
mod_id=${modId}
mod_name=${modName}
mod_license=MIT
mod_version=1.0.0
mod_group_id=${pkg}`,
  },
  fabric: {
    modAnnotation: '',
    registryImport: `import net.fabricmc.api.ModInitializer;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;`,
    blockRegisterApi: `import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.util.Identifier;`,
    itemRegisterApi: `import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.world.item.Item;
import net.minecraft.util.Identifier;`,
    creativeTabApi: `import net.fabricmc.fabric.api.itemgroup.v1.FabricItemGroup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.ItemStack;
import java.util.function.Supplier;`,
    mainModClass: (pkg: string, modId: string, modName: string) => `package ${pkg};

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ${toPascalCase(modId)}Mod implements ModInitializer {
    public static final String MOD_ID = "${modId}";
    public static final String MOD_NAME = "${modName}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_NAME);

    @Override
    public void onInitialize() {
        ModItems.register();
        ModBlocks.register();
        ModCreativeTabs.register();
    }
}`,
    itemRegistryClass: (pkg: string, modId: string) => `package ${pkg};

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.Item;
import net.neoforged.neoforge.registries.DeferredRegister;

public class ModItems {
    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(Registries.ITEM, ${toPascalCase(modId)}Mod.MOD_ID);

    // 在此注册物品，例如：
    // public static final RegistryObject<Item> EXAMPLE_ITEM = ITEMS.register("example_item",
    //     () -> new Item(new Item.Properties()));
}`,
    blockRegistryClass: (pkg: string, modId: string) => `package ${pkg};

import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;

public class ModBlocks {
    // 在此注册方块，例如：
    // public static final Block EXAMPLE_BLOCK = new Block(BlockBehaviour.Properties.of());
}`,
    creativeTabClass: (pkg: string, modId: string) => `package ${pkg};

import net.fabricmc.fabric.api.itemgroup.v1.FabricItemGroup;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.ItemStack;

public class ModCreativeTabs {
    public static final CreativeModeTab ${toPascalCase(modId)}_TAB = Registry.register(
        BuiltInRegistries.CREATIVE_MODE_TAB,
        ResourceLocation.fromNamespaceAndPath(${toPascalCase(modId)}Mod.MOD_ID, "${modId}_tab"),
        FabricItemGroup.builder()
            .title(Component.translatable("itemGroup.${modId}"))
            .icon(() -> new ItemStack(/*ModItems.EXAMPLE_ITEM*/))
            .displayItems((params, output) -> {
                // output.accept(ModItems.EXAMPLE_ITEM);
                // output.accept(ModBlocks.EXAMPLE_BLOCK);
            })
            .build()
    );
}`,
    neoforgeModsToml: (_modId: string, _modName: string) => `// Fabric 使用 fabric.mod.json，不使用 neoforge.mods.toml`,
    gradleProps: (modId: string, modName: string, pkg: string) => `org.gradle.jvmargs=-Xmx3G
minecraft_version=1.21
yarn_mappings=1.21+build.1
loader_version=0.15.11
mod_id=${modId}
mod_name=${modName}
mod_license=MIT
mod_version=1.0.0
mod_group_id=${pkg}`,
  },
};

export const mcProjectScaffold = tool({
  description: `生成 Minecraft 模组项目的骨架代码结构（主类、注册类、创造模式标签页等），支持 NeoForge / Forge / Fabric 三种加载器。自动创建模组主类、物品/方块注册类、创造模式标签页等基础框架。`,
  inputSchema: z.object({
    modId: z.string().describe('模组 ID（如 my_mod，仅小写字母、数字、下划线）'),
    modName: z.string().describe('模组显示名称（如 My Mod）'),
    packageName: z.string().describe('基础包名（如 com.example.mymod）'),
    loader: z.string().describe('模组加载器类型：neoforge / forge / fabric'),
    outputPath: z.string().describe('生成代码的输出目录路径（项目根目录）'),
  }),
  execute: async ({ modId, modName, packageName, loader, outputPath }): Promise<string> => {
    const template = loaderTemplates[loader];
    if (!template) {
      return `❌ 不支持的加载器类型: ${loader}。支持: neoforge, forge, fabric`;
    }

    const srcDir = path.join(outputPath, 'src', 'main', 'java', ...packageName.split('.'));
    const resourcesDir = path.join(outputPath, 'src', 'main', 'resources');
    const assetsDir = path.join(resourcesDir, 'assets', modId);
    const dataDir = path.join(resourcesDir, 'data', modId);

    // 创建目录
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(path.join(assetsDir, 'blockstates'), { recursive: true });
    await fs.mkdir(path.join(assetsDir, 'items'), { recursive: true });
    await fs.mkdir(path.join(assetsDir, 'lang'), { recursive: true });
    await fs.mkdir(path.join(assetsDir, 'models', 'block'), { recursive: true });
    await fs.mkdir(path.join(assetsDir, 'models', 'item'), { recursive: true });
    await fs.mkdir(path.join(assetsDir, 'textures', 'block'), { recursive: true });
    await fs.mkdir(path.join(assetsDir, 'textures', 'item'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'recipe'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'loot_table', 'blocks'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'tags', 'block'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'tags', 'item'), { recursive: true });
    await fs.mkdir(path.join(resourcesDir, 'META-INF'), { recursive: true });

    // 写入文件
    const files: { path: string; content: string }[] = [
      {
        path: path.join(srcDir, `${toPascalCase(modId)}Mod.java`),
        content: template.mainModClass(packageName, modId, modName),
      },
      {
        path: path.join(srcDir, 'ModBlocks.java'),
        content: template.blockRegistryClass(packageName, modId),
      },
      {
        path: path.join(srcDir, 'ModItems.java'),
        content: template.itemRegistryClass(packageName, modId),
      },
      {
        path: path.join(srcDir, 'ModCreativeTabs.java'),
        content: template.creativeTabClass(packageName, modId),
      },
      {
        path: path.join(resourcesDir, 'META-INF', 'neoforge.mods.toml'),
        content: template.neoforgeModsToml(modId, modName),
      },
      {
        path: path.join(outputPath, 'gradle.properties'),
        content: template.gradleProps(modId, modName, packageName),
      },
      {
        path: path.join(assetsDir, 'lang', 'en_us.json'),
        content: JSON.stringify({ [`itemGroup.${modId}`]: modName }, null, 2),
      },
    ];

    for (const file of files) {
      // 确保父目录存在
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      await fs.writeFile(file.path, file.content, 'utf-8');
    }

    const createdFiles = files.map(f => `  - ${path.relative(outputPath, f.path)}`).join('\n');

    return `✅ 项目骨架已生成到 ${outputPath}\n\n生成的文件：\n${createdFiles}\n\n📝 下一步建议：\n1. 编辑 gradle.properties 中的版本号\n2. 在 ModItems.java 中添加物品注册\n3. 在 ModBlocks.java 中添加方块注册\n4. 在 ModCreativeTabs.java 的 displayItems 中添加物品\n5. 运行 gradlew genSources 生成依赖`;
  },
});
