import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

interface RecipeJson {
  type: string;
  [key: string]: unknown;
}

function buildRecipeJson(
  recipeType: string,
  input: string,
  output: string,
  outputCount: number
): RecipeJson {
  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(input);
  } catch {
    parsedInput = input; // 当作纯字符串
  }

  const result = {
    id: output,
    count: outputCount || 1,
  };

  switch (recipeType) {
    case 'shaped': {
      const inp = parsedInput as { pattern?: string[]; key?: Record<string, unknown> } || {};
      return {
        type: 'minecraft:crafting_shaped',
        pattern: inp.pattern || ['###', '###', '###'],
        key: inp.key || { '#': { item: input } },
        result,
      };
    }
    case 'shapeless': {
      const inp = Array.isArray(parsedInput) ? parsedInput : [{ item: input }];
      return {
        type: 'minecraft:crafting_shapeless',
        ingredients: inp,
        result,
      };
    }
    case 'smelting': {
      return {
        type: 'minecraft:smelting',
        ingredient: typeof parsedInput === 'string' ? { item: parsedInput } : parsedInput,
        result: { id: output },
        experience: 0.7,
        cookingtime: 200,
      };
    }
    case 'blasting': {
      return {
        type: 'minecraft:blasting',
        ingredient: typeof parsedInput === 'string' ? { item: parsedInput } : parsedInput,
        result: { id: output },
        experience: 0.7,
        cookingtime: 100,
      };
    }
    case 'smoking': {
      return {
        type: 'minecraft:smoking',
        ingredient: typeof parsedInput === 'string' ? { item: parsedInput } : parsedInput,
        result: { id: output },
        experience: 0.35,
        cookingtime: 100,
      };
    }
    case 'campfire_cooking': {
      return {
        type: 'minecraft:campfire_cooking',
        ingredient: typeof parsedInput === 'string' ? { item: parsedInput } : parsedInput,
        result: { id: output },
        experience: 0.35,
        cookingtime: 600,
      };
    }
    case 'stonecutting': {
      return {
        type: 'minecraft:stonecutting',
        ingredient: typeof parsedInput === 'string' ? { item: parsedInput } : parsedInput,
        result,
      };
    }
    case 'smithing': {
      const inp = parsedInput as { base?: unknown; addition?: unknown; template?: unknown } || {};
      return {
        type: 'minecraft:smithing_transform',
        template: inp.template || { item: 'minecraft:netherite_upgrade_smithing_template' },
        base: inp.base || { item: 'minecraft:diamond_sword' },
        addition: inp.addition || { item: output },
        result,
      };
    }
    default:
      return {
        type: 'minecraft:crafting_shapeless',
        ingredients: [{ item: input }],
        result,
      };
  }
}

export const mcGenRecipe = tool({
  description: `生成 Minecraft 配方 JSON 文件。支持有序合成、无序合成、熔炼、高炉、烟熏炉、锻造台等多种配方类型。自动输出到 data/<modId>/recipe/ 目录。`,
  inputSchema: z.object({
    modId: z.string().describe('模组 ID'),
    recipeName: z.string().describe('配方文件名（如 ruby_from_ore）'),
    recipeType: z.string().describe('配方类型: shaped / shapeless / smelting / blasting / smoking / campfire_cooking / stonecutting / smithing'),
    input: z.string().describe('输入 JSON 字符串。不同配方类型不同：shaped 传 {\"pattern\":[\"###\",\"###\",\"###\"],\"key\":{\"#\":{\"item\":\"minecraft:stone\"}}}；shapeless 传物品数组；熔炼相关传单个物品或 json 对象'),
    output: z.string().describe('输出物品 ID（如 mod_id:ruby）'),
    outputCount: z.number().describe('输出数量，默认 1').default(1),
    outputPath: z.string().describe('输出目录路径（项目根目录）'),
  }),
  execute: async ({ modId, recipeName, recipeType, input, output, outputCount, outputPath }): Promise<string> => {
    const recipeDir = path.join(outputPath, 'src', 'main', 'resources', 'data', modId, 'recipe');
    await fs.mkdir(recipeDir, { recursive: true });

    const recipeJson = buildRecipeJson(recipeType, input, output, outputCount);
    await fs.writeFile(
      path.join(recipeDir, `${recipeName}.json`),
      JSON.stringify(recipeJson, null, 2),
      'utf-8'
    );

    const typeNames: Record<string, string> = {
      shaped: '有序合成',
      shapeless: '无序合成',
      smelting: '熔炼',
      blasting: '高炉',
      smoking: '烟熏炉',
      campfire_cooking: '营火烹饪',
      stonecutting: '切石机',
      smithing: '锻造',
    };

    return [
      `✅ 配方 "${recipeName}" (${typeNames[recipeType] || recipeType}) 已生成！`,
      '',
      `📦 ${path.join('data', modId, 'recipe', `${recipeName}.json`)}`,
      '',
      '```json',
      JSON.stringify(recipeJson, null, 2),
      '```',
    ].join('\n');
  },
});
