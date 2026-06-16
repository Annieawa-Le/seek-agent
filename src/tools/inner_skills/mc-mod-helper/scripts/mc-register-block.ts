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

function generateBlockstateJson(modId: string, blockName: string, blockType: string): object {
  switch (blockType) {
    case 'stairs': {
      return {
        variants: {
          'facing=east,half=bottom,shape=inner_left': { model: `${modId}:block/${blockName}_inner`, y: 270 },
          'facing=east,half=bottom,shape=inner_right': { model: `${modId}:block/${blockName}_inner` },
          'facing=east,half=bottom,shape=outer_left': { model: `${modId}:block/${blockName}_outer`, y: 270 },
          'facing=east,half=bottom,shape=outer_right': { model: `${modId}:block/${blockName}_outer` },
          'facing=east,half=bottom,shape=straight': { model: `${modId}:block/${blockName}` },
          'facing=east,half=top,shape=inner_left': { model: `${modId}:block/${blockName}_inner`, x: 180, u: true },
          'facing=east,half=top,shape=inner_right': { model: `${modId}:block/${blockName}_inner`, x: 180, y: 90, u: true },
          'facing=east,half=top,shape=outer_left': { model: `${modId}:block/${blockName}_outer`, x: 180, u: true },
          'facing=east,half=top,shape=outer_right': { model: `${modId}:block/${blockName}_outer`, x: 180, y: 90, u: true },
          'facing=east,half=top,shape=straight': { model: `${modId}:block/${blockName}`, x: 180, u: true },
          'facing=north,half=bottom,shape=inner_left': { model: `${modId}:block/${blockName}_inner`, y: 180 },
          'facing=north,half=bottom,shape=inner_right': { model: `${modId}:block/${blockName}_inner`, y: 270 },
          'facing=north,half=bottom,shape=outer_left': { model: `${modId}:block/${blockName}_outer`, y: 180 },
          'facing=north,half=bottom,shape=outer_right': { model: `${modId}:block/${blockName}_outer`, y: 270 },
          'facing=north,half=bottom,shape=straight': { model: `${modId}:block/${blockName}`, y: 270 },
          'facing=north,half=top,shape=inner_left': { model: `${modId}:block/${blockName}_inner`, x: 180, y: 90, u: true },
          'facing=north,half=top,shape=inner_right': { model: `${modId}:block/${blockName}_inner`, x: 180, y: 180, u: true },
          'facing=north,half=top,shape=outer_left': { model: `${modId}:block/${blockName}_outer`, x: 180, y: 90, u: true },
          'facing=north,half=top,shape=outer_right': { model: `${modId}:block/${blockName}_outer`, x: 180, y: 180, u: true },
          'facing=north,half=top,shape=straight': { model: `${modId}:block/${blockName}`, x: 180, y: 270, u: true },
          'facing=south,half=bottom,shape=inner_left': { model: `${modId}:block/${blockName}_inner` },
          'facing=south,half=bottom,shape=inner_right': { model: `${modId}:block/${blockName}_inner`, y: 90 },
          'facing=south,half=bottom,shape=outer_left': { model: `${modId}:block/${blockName}_outer` },
          'facing=south,half=bottom,shape=outer_right': { model: `${modId}:block/${blockName}_outer`, y: 90 },
          'facing=south,half=bottom,shape=straight': { model: `${modId}:block/${blockName}`, y: 180 },
          'facing=south,half=top,shape=inner_left': { model: `${modId}:block/${blockName}_inner`, x: 180, y: 270, u: true },
          'facing=south,half=top,shape=inner_right': { model: `${modId}:block/${blockName}_inner`, x: 180, u: true },
          'facing=south,half=top,shape=outer_left': { model: `${modId}:block/${blockName}_outer`, x: 180, y: 270, u: true },
          'facing=south,half=top,shape=outer_right': { model: `${modId}:block/${blockName}_outer`, x: 180, u: true },
          'facing=south,half=top,shape=straight': { model: `${modId}:block/${blockName}`, x: 180, y: 180, u: true },
          'facing=west,half=bottom,shape=inner_left': { model: `${modId}:block/${blockName}_inner`, y: 90 },
          'facing=west,half=bottom,shape=inner_right': { model: `${modId}:block/${blockName}_inner`, y: 180 },
          'facing=west,half=bottom,shape=outer_left': { model: `${modId}:block/${blockName}_outer`, y: 90 },
          'facing=west,half=bottom,shape=outer_right': { model: `${modId}:block/${blockName}_outer`, y: 180 },
          'facing=west,half=bottom,shape=straight': { model: `${modId}:block/${blockName}`, y: 90 },
          'facing=west,half=top,shape=inner_left': { model: `${modId}:block/${blockName}_inner`, x: 180, y: 180, u: true },
          'facing=west,half=top,shape=inner_right': { model: `${modId}:block/${blockName}_inner`, x: 180, y: 270, u: true },
          'facing=west,half=top,shape=outer_left': { model: `${modId}:block/${blockName}_outer`, x: 180, y: 180, u: true },
          'facing=west,half=top,shape=outer_right': { model: `${modId}:block/${blockName}_outer`, x: 180, y: 270, u: true },
          'facing=west,half=top,shape=straight': { model: `${modId}:block/${blockName}`, x: 180, y: 90, u: true },
        },
      };
    }
    case 'slab': {
      return {
        variants: {
          'type=bottom': { model: `${modId}:block/${blockName}` },
          'type=double': { model: `${modId}:block/${blockName}_double` },
          'type=top': { model: `${modId}:block/${blockName}`, x: 180, u: true },
        },
      };
    }
    case 'door': {
      return {
        variants: {
          'facing=east,half=lower,hinge=left,open=false': { model: `${modId}:block/${blockName}_bottom_left` },
          'facing=east,half=lower,hinge=left,open=true': { model: `${modId}:block/${blockName}_bottom_left_open`, y: 90 },
          'facing=east,half=lower,hinge=right,open=false': { model: `${modId}:block/${blockName}_bottom_right` },
          'facing=east,half=lower,hinge=right,open=true': { model: `${modId}:block/${blockName}_bottom_right_open`, y: 90 },
          'facing=east,half=upper,hinge=left,open=false': { model: `${modId}:block/${blockName}_top_left` },
          'facing=east,half=upper,hinge=left,open=true': { model: `${modId}:block/${blockName}_top_left_open`, y: 90 },
          'facing=east,half=upper,hinge=right,open=false': { model: `${modId}:block/${blockName}_top_right` },
          'facing=east,half=upper,hinge=right,open=true': { model: `${modId}:block/${blockName}_top_right_open`, y: 90 },
          'facing=north,half=lower,hinge=left,open=false': { model: `${modId}:block/${blockName}_bottom_left`, y: 270 },
          'facing=north,half=lower,hinge=left,open=true': { model: `${modId}:block/${blockName}_bottom_left_open` },
          'facing=north,half=lower,hinge=right,open=false': { model: `${modId}:block/${blockName}_bottom_right`, y: 270 },
          'facing=north,half=lower,hinge=right,open=true': { model: `${modId}:block/${blockName}_bottom_right_open` },
          'facing=north,half=upper,hinge=left,open=false': { model: `${modId}:block/${blockName}_top_left`, y: 270 },
          'facing=north,half=upper,hinge=left,open=true': { model: `${modId}:block/${blockName}_top_left_open` },
          'facing=north,half=upper,hinge=right,open=false': { model: `${modId}:block/${blockName}_top_right`, y: 270 },
          'facing=north,half=upper,hinge=right,open=true': { model: `${modId}:block/${blockName}_top_right_open` },
          'facing=south,half=lower,hinge=left,open=false': { model: `${modId}:block/${blockName}_bottom_left`, y: 90 },
          'facing=south,half=lower,hinge=left,open=true': { model: `${modId}:block/${blockName}_bottom_left_open`, y: 180 },
          'facing=south,half=lower,hinge=right,open=false': { model: `${modId}:block/${blockName}_bottom_right`, y: 90 },
          'facing=south,half=lower,hinge=right,open=true': { model: `${modId}:block/${blockName}_bottom_right_open`, y: 180 },
          'facing=south,half=upper,hinge=left,open=false': { model: `${modId}:block/${blockName}_top_left`, y: 90 },
          'facing=south,half=upper,hinge=left,open=true': { model: `${modId}:block/${blockName}_top_left_open`, y: 180 },
          'facing=south,half=upper,hinge=right,open=false': { model: `${modId}:block/${blockName}_top_right`, y: 90 },
          'facing=south,half=upper,hinge=right,open=true': { model: `${modId}:block/${blockName}_top_right_open`, y: 180 },
          'facing=west,half=lower,hinge=left,open=false': { model: `${modId}:block/${blockName}_bottom_left`, y: 180 },
          'facing=west,half=lower,hinge=left,open=true': { model: `${modId}:block/${blockName}_bottom_left_open`, y: 270 },
          'facing=west,half=lower,hinge=right,open=false': { model: `${modId}:block/${blockName}_bottom_right`, y: 180 },
          'facing=west,half=lower,hinge=right,open=true': { model: `${modId}:block/${blockName}_bottom_right_open`, y: 270 },
          'facing=west,half=upper,hinge=left,open=false': { model: `${modId}:block/${blockName}_top_left`, y: 180 },
          'facing=west,half=upper,hinge=left,open=true': { model: `${modId}:block/${blockName}_top_left_open`, y: 270 },
          'facing=west,half=upper,hinge=right,open=false': { model: `${modId}:block/${blockName}_top_right`, y: 180 },
          'facing=west,half=upper,hinge=right,open=true': { model: `${modId}:block/${blockName}_top_right_open`, y: 270 },
        },
      };
    }
    case 'trapdoor': {
      return {
        variants: {
          'facing=east,half=bottom,open=false': { model: `${modId}:block/${blockName}_bottom` },
          'facing=east,half=bottom,open=true': { model: `${modId}:block/${blockName}_open`, y: 90 },
          'facing=east,half=top,open=false': { model: `${modId}:block/${blockName}_top` },
          'facing=east,half=top,open=true': { model: `${modId}:block/${blockName}_open`, y: 90, x: 180 },
          'facing=north,half=bottom,open=false': { model: `${modId}:block/${blockName}_bottom` },
          'facing=north,half=bottom,open=true': { model: `${modId}:block/${blockName}_open` },
          'facing=north,half=top,open=false': { model: `${modId}:block/${blockName}_top` },
          'facing=north,half=top,open=true': { model: `${modId}:block/${blockName}_open`, x: 180 },
          'facing=south,half=bottom,open=false': { model: `${modId}:block/${blockName}_bottom` },
          'facing=south,half=bottom,open=true': { model: `${modId}:block/${blockName}_open`, y: 180 },
          'facing=south,half=top,open=false': { model: `${modId}:block/${blockName}_top` },
          'facing=south,half=top,open=true': { model: `${modId}:block/${blockName}_open`, x: 180, y: 180 },
          'facing=west,half=bottom,open=false': { model: `${modId}:block/${blockName}_bottom` },
          'facing=west,half=bottom,open=true': { model: `${modId}:block/${blockName}_open`, y: 270 },
          'facing=west,half=top,open=false': { model: `${modId}:block/${blockName}_top` },
          'facing=west,half=top,open=true': { model: `${modId}:block/${blockName}_open`, x: 180, y: 270 },
        },
      };
    }
    case 'fence': {
      return {
        multipart: [
          { apply: { model: `${modId}:block/${blockName}_post` } },
          { when: { north: 'true' }, apply: { model: `${modId}:block/${blockName}_side`, uvlock: true } },
          { when: { east: 'true' }, apply: { model: `${modId}:block/${blockName}_side`, y: 90, uvlock: true } },
          { when: { south: 'true' }, apply: { model: `${modId}:block/${blockName}_side`, y: 180, uvlock: true } },
          { when: { west: 'true' }, apply: { model: `${modId}:block/${blockName}_side`, y: 270, uvlock: true } },
        ],
      };
    }
    case 'wall': {
      return {
        multipart: [
          { apply: { model: `${modId}:block/${blockName}_post` } },
          { when: { north: 'low' }, apply: { model: `${modId}:block/${blockName}_side`, uvlock: true } },
          { when: { east: 'low' }, apply: { model: `${modId}:block/${blockName}_side`, y: 90, uvlock: true } },
          { when: { south: 'low' }, apply: { model: `${modId}:block/${blockName}_side`, y: 180, uvlock: true } },
          { when: { west: 'low' }, apply: { model: `${modId}:block/${blockName}_side`, y: 270, uvlock: true } },
          { when: { north: 'tall' }, apply: { model: `${modId}:block/${blockName}_side_tall`, uvlock: true } },
          { when: { east: 'tall' }, apply: { model: `${modId}:block/${blockName}_side_tall`, y: 90, uvlock: true } },
          { when: { south: 'tall' }, apply: { model: `${modId}:block/${blockName}_side_tall`, y: 180, uvlock: true } },
          { when: { west: 'tall' }, apply: { model: `${modId}:block/${blockName}_side_tall`, y: 270, uvlock: true } },
        ],
      };
    }
    default: {
      return { variants: { '': { model: `${modId}:block/${blockName}` } } };
    }
  }
}

function generateBlockModelJson(modId: string, blockName: string, blockType: string): object {
  const tex = `${modId}:block/${blockName}`;
  switch (blockType) {
    case 'stairs': {
      return { parent: 'minecraft:block/stairs', textures: { bottom: tex, top: tex, side: tex } };
    }
    case 'slab': {
      return { parent: 'minecraft:block/slab', textures: { bottom: tex, top: tex, side: tex } };
    }
    case 'door': {
      return { parent: 'minecraft:block/door_bottom_left', textures: { bottom: `${tex}_bottom`, top: `${tex}_top` } };
    }
    case 'trapdoor': {
      return { parent: 'minecraft:block/trapdoor_bottom', textures: { texture: tex } };
    }
    default: {
      return { parent: 'minecraft:block/cube_all', textures: { all: tex } };
    }
  }
}

function generateLootTableJson(modId: string, blockName: string, blockType: string): object {
  // 基础掉落自身
  if (blockType === 'ore') {
    return {
      type: 'minecraft:block',
      pools: [{
        rolls: 1,
        entries: [{
          type: 'minecraft:item',
          name: `${modId}:${blockName}`,
          functions: [{
            function: 'minecraft:apply_bonus',
            enchantment: 'minecraft:fortune',
            formula: 'minecraft:ore_drops',
          }],
        }],
        conditions: [{ condition: 'minecraft:survives_explosion' }],
      }],
    };
  }
  if (blockType === 'door') {
    return {
      type: 'minecraft:block',
      pools: [{
        rolls: 1,
        entries: [{ type: 'minecraft:item', name: `${modId}:${blockName}` }],
        conditions: [{ condition: 'minecraft:survives_explosion' }],
      }],
    };
  }
  return {
    type: 'minecraft:block',
    pools: [{
      rolls: 1,
      entries: [{ type: 'minecraft:item', name: `${modId}:${blockName}` }],
      conditions: [{ condition: 'minecraft:survives_explosion' }],
    }],
  };
}

export const mcRegisterBlock = tool({
  description: `生成模组方块的注册代码和相关资源文件。生成方块注册代码、方块状态 JSON、方块模型 JSON、物品模型 JSON、战利品表 JSON、语言文件条目。支持多种方块类型。`,
  inputSchema: z.object({
    modId: z.string().describe('模组 ID'),
    blockName: z.string().describe('方块注册名（如 ruby_ore）'),
    blockType: z.string().describe('方块类型: basic / ore / stairs / slab / wall / fence / door / trapdoor'),
    loader: z.string().describe('模组加载器类型：neoforge / forge / fabric'),
    packageName: z.string().describe('基础包名'),
    outputPath: z.string().describe('输出目录路径（项目根目录）'),
  }),
  execute: async ({ modId, blockName, blockType, loader, packageName, outputPath }): Promise<string> => {
    const pascalName = toPascalCase(blockName);
    const fieldName = pascalName.toUpperCase();

    const assetsDir = path.join(outputPath, 'src', 'main', 'resources', 'assets', modId);
    const blockstatesDir = path.join(assetsDir, 'blockstates');
    const blockModelDir = path.join(assetsDir, 'models', 'block');
    const itemModelDir = path.join(assetsDir, 'models', 'item');
    const itemDefDir = path.join(assetsDir, 'items');
    const lootTableDir = path.join(outputPath, 'src', 'main', 'resources', 'data', modId, 'loot_table', 'blocks');

    await fs.mkdir(blockstatesDir, { recursive: true });
    await fs.mkdir(blockModelDir, { recursive: true });
    await fs.mkdir(itemModelDir, { recursive: true });
    await fs.mkdir(itemDefDir, { recursive: true });
    await fs.mkdir(lootTableDir, { recursive: true });

    // 1. 方块状态 JSON
    await fs.writeFile(
      path.join(blockstatesDir, `${blockName}.json`),
      JSON.stringify(generateBlockstateJson(modId, blockName, blockType), null, 2),
      'utf-8'
    );

    // 2. 方块模型 JSON
    await fs.writeFile(
      path.join(blockModelDir, `${blockName}.json`),
      JSON.stringify(generateBlockModelJson(modId, blockName, blockType), null, 2),
      'utf-8'
    );

    // 3. 物品模型 JSON (BlockItem)
    const itemModel = {
      parent: `${modId}:block/${blockName}`,
    };
    await fs.writeFile(
      path.join(itemModelDir, `${blockName}.json`),
      JSON.stringify(itemModel, null, 2),
      'utf-8'
    );

    // 4. 客户端物品定义
    const clientItem = {
      model: { type: 'minecraft:model', model: `${modId}:item/${blockName}` },
    };
    await fs.writeFile(
      path.join(itemDefDir, `${blockName}.json`),
      JSON.stringify(clientItem, null, 2),
      'utf-8'
    );

    // 5. 台阶/楼梯需要额外的模型文件
    if (blockType === 'slab') {
      // double slab 模型
      await fs.writeFile(
        path.join(blockModelDir, `${blockName}_double.json`),
        JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: `${modId}:block/${blockName}` } }, null, 2),
        'utf-8'
      );
    }

    // 6. 战利品表
    await fs.writeFile(
      path.join(lootTableDir, `${blockName}.json`),
      JSON.stringify(generateLootTableJson(modId, blockName, blockType), null, 2),
      'utf-8'
    );

    // 确定 Java 类
    let blockClass = 'Block';
    let blockProperties = '';
    const extraImports: string[] = [];

    switch (blockType) {
      case 'basic': blockClass = 'Block'; break;
      case 'ore': blockClass = 'Block'; break;
      case 'stairs': blockClass = 'StairBlock'; extraImports.push('net.minecraft.world.level.block.StairBlock'); break;
      case 'slab': blockClass = 'SlabBlock'; extraImports.push('net.minecraft.world.level.block.SlabBlock'); break;
      case 'wall': blockClass = 'WallBlock'; extraImports.push('net.minecraft.world.level.block.WallBlock'); break;
      case 'fence': blockClass = 'FenceBlock'; extraImports.push('net.minecraft.world.level.block.FenceBlock'); break;
      case 'door': blockClass = 'DoorBlock'; extraImports.push('net.minecraft.world.level.block.DoorBlock'); break;
      case 'trapdoor': blockClass = 'TrapDoorBlock'; extraImports.push('net.minecraft.world.level.block.TrapDoorBlock'); break;
    }

    // 方块属性
    if (blockType === 'ore') {
      blockProperties = '.requiresCorrectToolForDrops().destroyTime(3.0f).explosionResistance(3.0f)';
    } else if (blockType === 'door' || blockType === 'trapdoor') {
      blockProperties = '.noOcclusion().destroyTime(3.0f).sound(net.minecraft.world.level.block.SoundType.WOOD)';
    } else {
      blockProperties = '.destroyTime(5.0f).explosionResistance(6.0f).requiresCorrectToolForDrops()';
    }

    // 生成注册代码
    let blockRegistration = '';
    let itemRegistration = '';

    if (loader === 'neoforge') {
      if (blockType === 'basic' || blockType === 'ore') {
        blockRegistration = `public static final DeferredBlock<Block> ${fieldName} = BLOCKS.registerSimpleBlock(\n    "${blockName}",\n    BlockBehaviour.Properties.of()${blockProperties}\n);`;
      } else {
        blockRegistration = `public static final DeferredBlock<${blockClass}> ${fieldName} = BLOCKS.registerBlock(\n    "${blockName}",\n    ${blockClass}::new,\n    BlockBehaviour.Properties.of()${blockProperties}\n);`;
      }
      itemRegistration = `public static final DeferredItem<BlockItem> ${fieldName}_ITEM = ITEMS.registerSimpleBlockItem("${blockName}", ModBlocks.${fieldName});`;
    } else if (loader === 'forge') {
      blockRegistration = `public static final RegistryObject<${blockClass}> ${fieldName} = BLOCKS.register("${blockName}",\n    () -> new ${blockClass}(BlockBehaviour.Properties.of()${blockProperties})\n);`;
      itemRegistration = `public static final RegistryObject<BlockItem> ${fieldName}_ITEM = ITEMS.register("${blockName}",\n    () -> new BlockItem(ModBlocks.${fieldName}.get(), new Item.Properties())\n);`;
    } else {
      // fabric
      blockRegistration = `public static final ${blockClass} ${fieldName} = Registry.register(\n    BuiltInRegistries.BLOCK,\n    Identifier.of("${modId}", "${blockName}"),\n    new ${blockClass}(BlockBehaviour.Properties.of()${blockProperties})\n);`;
      itemRegistration = `public static final Item ${fieldName}_ITEM = Registry.register(\n    BuiltInRegistries.ITEM,\n    Identifier.of("${modId}", "${blockName}"),\n    new BlockItem(ModBlocks.${fieldName}, new Item.Settings())\n);`;
    }

    const result = [
      `✅ 方块 "${blockName}" 的资源文件已生成！`,
      '',
      '📦 生成的文件:',
      `  - assets/${modId}/blockstates/${blockName}.json`,
      `  - assets/${modId}/models/block/${blockName}.json`,
      `  - assets/${modId}/models/item/${blockName}.json`,
      `  - assets/${modId}/items/${blockName}.json`,
      `  - data/${modId}/loot_table/blocks/${blockName}.json`,
      '',
      '📝 将以下代码添加到 ModBlocks.java：',
      '```java',
      blockRegistration,
      '```',
      '',
      '📝 将以下代码添加到 ModItems.java：',
      '```java',
      itemRegistration,
      '```',
      '',
      '📝 语言文件翻译键:',
      `  "block.${modId}.${blockName}": "${pascalName}"`,
    ];

    if (blockType !== 'basic' && blockType !== 'ore') {
      result.push('', '📝 额外需要导入：');
      result.push('```java');
      extraImports.forEach(i => result.push(`import ${i};`));
      result.push('```');
    }

    if (blockType === 'door') {
      result.push('', '⚠️ 门方块需要额外的模型文件（_bottom_left, _bottom_right, _top_left, _top_right 及 _open 变体），请根据实际需求生成。');
    }

    return result.join('\n');
  },
});
