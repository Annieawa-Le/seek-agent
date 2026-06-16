import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

function buildModelJson(modId: string, modelType: string, texturesStr: string): object {
  let textures: Record<string, string> = {};
  try {
    textures = JSON.parse(texturesStr);
  } catch {
    // 使用默认值
  }

  // 如果用户传了空对象或未传有效值，根据 modelType 生成默认纹理映射
  if (Object.keys(textures).length === 0) {
    switch (modelType) {
      case 'generated':
        textures = { layer0: `${modId}:item/${'item'}` };
        break;
      case 'block':
      case 'cube_all':
        textures = { all: `${modId}:block/${'block'}` };
        break;
      case 'cross':
        textures = { cross: `${modId}:block/${'plant'}` };
        break;
      case 'cube_bottom_top':
        textures = {
          bottom: `${modId}:block/${'bottom'}`,
          top: `${modId}:block/${'top'}`,
          side: `${modId}:block/${'side'}`,
        };
        break;
      case 'orientable':
        textures = {
          front: `${modId}:block/${'front'}`,
          side: `${modId}:block/${'side'}`,
          top: `${modId}:block/${'top'}`,
        };
        break;
      default:
        textures = { all: `${modId}:block/${'block'}` };
    }
  }

  const parentMap: Record<string, string> = {
    generated: 'minecraft:item/generated',
    handheld: 'minecraft:item/handheld',
    block: 'minecraft:block/cube_all',
    cube_all: 'minecraft:block/cube_all',
    cube_bottom_top: 'minecraft:block/cube_bottom_top',
    oriented: 'minecraft:block/orientable',
    orientable: 'minecraft:block/orientable',
    cross: 'minecraft:block/cross',
    stairs: 'minecraft:block/stairs',
    slab: 'minecraft:block/slab',
    wall: 'minecraft:block/wall_side_tall',
  };

  return {
    parent: parentMap[modelType] || 'minecraft:block/cube_all',
    textures,
  };
}

function buildBlockstateJson(modId: string, targetName: string, modelType: string): object {
  const modelId = `${modId}:block/${targetName}`;

  switch (modelType) {
    case 'stairs': {
      return {
        variants: {
          '': { model: modelId },
          'facing=east,half=bottom,shape=straight': { model: modelId },
          'facing=west,half=bottom,shape=straight': { model: modelId, y: 180 },
          'facing=south,half=bottom,shape=straight': { model: modelId, y: 270 },
          'facing=north,half=bottom,shape=straight': { model: modelId, y: 90 },
        },
      };
    }
    case 'slab': {
      return {
        variants: {
          'type=bottom': { model: modelId },
          'type=double': { model: `${modelId}_double` },
          'type=top': { model: modelId, x: 180, uvlock: true },
        },
      };
    }
    case 'oriented':
    case 'orientable': {
      return {
        variants: {
          'facing=north': { model: modelId },
          'facing=south': { model: modelId, y: 180 },
          'facing=west': { model: modelId, y: 270 },
          'facing=east': { model: modelId, y: 90 },
        },
      };
    }
    case 'cross': {
      return { variants: { '': { model: modelId } } };
    }
    default: {
      return { variants: { '': { model: modelId } } };
    }
  }
}

export const mcGenModel = tool({
  description: `生成 Minecraft 物品/方块模型 JSON 文件和方块状态 JSON。支持多种模型类型，自动处理纹理路径。`,
  inputSchema: z.object({
    modId: z.string().describe('模组 ID'),
    targetName: z.string().describe('物品/方块注册名'),
    targetType: z.string().describe('目标类型：item（物品模型）/ block（方块模型）/ blockstate（方块状态）'),
    modelType: z.string().describe('模型类型：generated / handheld / cube_all / cube_bottom_top / orientable / cross / stairs / slab'),
    textures: z.string().describe('纹理映射 JSON 字符串，如 {"layer0":"mod_id:item/ruby"} 或 {"all":"mod_id:block/ruby_block"}'),
    outputPath: z.string().describe('输出目录路径（项目根目录）'),
  }),
  execute: async ({ modId, targetName, targetType, modelType, textures, outputPath }): Promise<string> => {
    const assetsDir = path.join(outputPath, 'src', 'main', 'resources', 'assets', modId);

    const generatedFiles: string[] = [];

    if (targetType === 'item') {
      const modelDir = path.join(assetsDir, 'models', 'item');
      await fs.mkdir(modelDir, { recursive: true });

      const modelJson = buildModelJson(modId, modelType, textures);
      await fs.writeFile(
        path.join(modelDir, `${targetName}.json`),
        JSON.stringify(modelJson, null, 2),
        'utf-8'
      );
      generatedFiles.push(`assets/${modId}/models/item/${targetName}.json`);

      // 也生成客户端物品定义
      const itemsDir = path.join(assetsDir, 'items');
      await fs.mkdir(itemsDir, { recursive: true });
      const clientItem = { model: { type: 'minecraft:model', model: `${modId}:item/${targetName}` } };
      await fs.writeFile(
        path.join(itemsDir, `${targetName}.json`),
        JSON.stringify(clientItem, null, 2),
        'utf-8'
      );
      generatedFiles.push(`assets/${modId}/items/${targetName}.json`);
    }

    if (targetType === 'block') {
      const modelDir = path.join(assetsDir, 'models', 'block');
      await fs.mkdir(modelDir, { recursive: true });

      const modelJson = buildModelJson(modId, modelType, textures);
      await fs.writeFile(
        path.join(modelDir, `${targetName}.json`),
        JSON.stringify(modelJson, null, 2),
        'utf-8'
      );
      generatedFiles.push(`assets/${modId}/models/block/${targetName}.json`);
    }

    if (targetType === 'blockstate') {
      const blockstatesDir = path.join(assetsDir, 'blockstates');
      await fs.mkdir(blockstatesDir, { recursive: true });

      const blockstateJson = buildBlockstateJson(modId, targetName, modelType);
      await fs.writeFile(
        path.join(blockstatesDir, `${targetName}.json`),
        JSON.stringify(blockstateJson, null, 2),
        'utf-8'
      );
      generatedFiles.push(`assets/${modId}/blockstates/${targetName}.json`);
    }

    if (generatedFiles.length === 0) {
      return `❌ 无效的 targetType: ${targetType}。支持: item / block / blockstate`;
    }

    return [
      `✅ 模型文件已生成！`,
      '',
      '📦 生成的文件:',
      ...generatedFiles.map(f => `  - ${f}`),
      '',
      '```json',
      JSON.stringify(buildModelJson(modId, modelType, textures), null, 2),
      '```',
    ].join('\n');
  },
});
