import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

function buildLootTableJson(lootType: string, poolsStr: string): object {
  let pools: unknown[];
  try {
    const parsed = JSON.parse(poolsStr);
    pools = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    pools = [
      {
        rolls: 1,
        entries: [{ type: 'minecraft:item', name: 'minecraft:dirt' }],
        conditions: [{ condition: 'minecraft:survives_explosion' }],
      },
    ];
  }

  const typeMap: Record<string, string> = {
    block: 'minecraft:block',
    entity: 'minecraft:entity',
    chest: 'minecraft:chest',
    fishing: 'minecraft:fishing',
    archaeology: 'minecraft:archaeology',
  };

  return {
    type: typeMap[lootType] || 'minecraft:block',
    pools,
  };
}

export const mcGenLootTable = tool({
  description: `生成 Minecraft 战利品表 JSON 文件。支持方块破坏掉落、实体掉落、钓鱼、宝箱等多种战利品表类型。`,
  inputSchema: z.object({
    modId: z.string().describe('模组 ID'),
    lootTableName: z.string().describe('战利品表名称（如 blocks/ruby_ore）'),
    lootType: z.string().describe('战利品表类型：block / entity / chest / fishing / archaeology'),
    pools: z.string().describe('战利品池 JSON 字符串，可以是单个池对象或多个池的数组'),
    outputPath: z.string().describe('输出目录路径（项目根目录）'),
  }),
  execute: async ({ modId, lootTableName, lootType, pools, outputPath }): Promise<string> => {
    const lootDir = path.join(outputPath, 'src', 'main', 'resources', 'data', modId, 'loot_table');
    await fs.mkdir(lootDir, { recursive: true });

    const lootJson = buildLootTableJson(lootType, pools);

    // 文件名处理：如果 lootTableName 包含路径分隔符，创建子目录
    const parts = lootTableName.split('/');
    const fileName = parts.pop() + '.json';
    const subDir = path.join(lootDir, ...parts);
    await fs.mkdir(subDir, { recursive: true });

    await fs.writeFile(
      path.join(subDir, fileName),
      JSON.stringify(lootJson, null, 2),
      'utf-8'
    );

    const relativePath = path.join('data', modId, 'loot_table', ...parts, fileName);

    return [
      `✅ 战利品表已生成！`,
      '',
      `📦 ${relativePath}`,
      '',
      '```json',
      JSON.stringify(lootJson, null, 2),
      '```',
      '',
      '💡 提示：如果战利品池需要修改，可通过修改 pools 参数重新生成。',
    ].join('\n');
  },
});
