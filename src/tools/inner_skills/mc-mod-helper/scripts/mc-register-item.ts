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

function getItemModelJson(modId: string, itemName: string, itemType: string): object {
  // 工具/武器使用 handheld 父模型
  const isHandheld = ['tool', 'sword', 'pickaxe', 'axe', 'shovel', 'hoe'].includes(itemType);
  return {
    parent: isHandheld ? 'minecraft:item/handheld' : 'minecraft:item/generated',
    textures: {
      layer0: `${modId}:item/${itemName}`,
    },
  };
}

export const mcRegisterItem = tool({
  description: `生成模组物品的注册代码和相关资源文件。根据加载器类型生成对应的注册方式（NeoForge DeferredRegister / Forge DeferredRegister / Fabric Registry 等），同时生成物品模型 JSON、语言文件条目。`,
  inputSchema: z.object({
    modId: z.string().describe('模组 ID'),
    itemName: z.string().describe('物品注册名（如 ruby）'),
    itemType: z.string().describe('物品类型: basic / food / tool / sword / pickaxe / axe / shovel / hoe / armor / blockItem'),
    loader: z.string().describe('模组加载器类型：neoforge / forge / fabric'),
    packageName: z.string().describe('基础包名（如 com.example.mymod）'),
    outputPath: z.string().describe('输出目录路径（项目根目录）'),
  }),
  execute: async ({ modId, itemName, itemType, loader, packageName, outputPath }): Promise<string> => {
    const pascalName = toPascalCase(itemName);
    const fieldName = pascalName.toUpperCase(); // e.g. RUBY
    const modelDir = path.join(outputPath, 'src', 'main', 'resources', 'assets', modId, 'models', 'item');
    const itemsDir = path.join(outputPath, 'src', 'main', 'resources', 'assets', modId, 'items');
    const texturesDir = path.join(outputPath, 'src', 'main', 'resources', 'assets', modId, 'textures', 'item');

    // 确保目录存在
    await fs.mkdir(modelDir, { recursive: true });
    await fs.mkdir(itemsDir, { recursive: true });
    await fs.mkdir(texturesDir, { recursive: true });

    // 写入物品模型 JSON
    const modelJson = getItemModelJson(modId, itemName, itemType);
    await fs.writeFile(
      path.join(modelDir, `${itemName}.json`),
      JSON.stringify(modelJson, null, 2),
      'utf-8'
    );

    // 写入客户端物品定义 (NeoForge 1.21+)
    const clientItemJson = {
      model: { type: 'minecraft:model', model: `${modId}:item/${itemName}` },
    };
    await fs.writeFile(
      path.join(itemsDir, `${itemName}.json`),
      JSON.stringify(clientItemJson, null, 2),
      'utf-8'
    );

    // 生成 Java 注册代码
    let registrationCode = '';
    let itemProperties = '';
    let itemClass = 'Item';

    switch (itemType) {
      case 'food': {
        itemClass = 'Item';
        itemProperties = `.food(new FoodProperties.Builder().nutrition(4).saturationMod(0.3f).build())`;
        break;
      }
      case 'tool':
      case 'sword': {
        itemClass = 'SwordItem';
        itemProperties = `.durability(250).enchantable(15)`;
        break;
      }
      case 'pickaxe': {
        itemClass = 'PickaxeItem';
        itemProperties = `.durability(250).enchantable(15)`;
        break;
      }
      case 'axe': {
        itemClass = 'AxeItem';
        itemProperties = `.durability(250).enchantable(15)`;
        break;
      }
      case 'shovel': {
        itemClass = 'ShovelItem';
        itemProperties = `.durability(250).enchantable(15)`;
        break;
      }
      case 'hoe': {
        itemClass = 'HoeItem';
        itemProperties = `.durability(250).enchantable(15)`;
        break;
      }
      case 'armor': {
        itemClass = 'ArmorItem';
        itemProperties = `.durability(200).enchantable(15)`;
        break;
      }
      default: {
        itemClass = 'Item';
        itemProperties = '';
      }
    }

    if (loader === 'neoforge') {
      if (itemType === 'basic' || itemType === 'food') {
        registrationCode = `public static final DeferredItem<Item> ${fieldName} = ITEMS.registerSimpleItem("${itemName}"${itemType === 'basic' ? '' : ', props -> props' + itemProperties});`;
      } else {
        registrationCode = `public static final DeferredItem<${itemClass}> ${fieldName} = ITEMS.registerItem(\n    "${itemName}",\n    ${itemClass}::new,\n    new Item.Properties()${itemProperties}\n);`;
      }
    } else if (loader === 'forge') {
      registrationCode = `public static final RegistryObject<${itemClass}> ${fieldName} = ITEMS.register("${itemName}",\n    () -> new ${itemClass}(new Item.Properties()${itemProperties})\n);`;
    } else if (loader === 'fabric') {
      registrationCode = `public static final ${itemClass} ${fieldName} = Registry.register(\n    BuiltInRegistries.ITEM,\n    Identifier.of("${modId}", "${itemName}"),\n    new ${itemClass}(new Item.Settings()${itemProperties.replace(/durability/g, 'maxDamage')})\n);`;
    }

    const result = [
      `✅ 物品 "${itemName}" 的资源文件已生成！`,
      '',
      '📦 生成的文件:',
      `  - assets/${modId}/models/item/${itemName}.json`,
      `  - assets/${modId}/items/${itemName}.json`,
      '',
      '📝 请将以下注册代码添加到 ModItems.java：',
      '```java',
      registrationCode,
      '```',
      '',
      '📝 语言文件翻译键:',
      `  "item.${modId}.${itemName}": "${pascalName}"`,
      '',
      '📝 如果是食物类型，请添加以下 import：',
      '```java',
      'import net.minecraft.world.food.FoodProperties;',
      '```',
    ];

    // 如果是工具，提示需要 Tier
    if (['tool', 'sword', 'pickaxe', 'axe', 'shovel', 'hoe'].includes(itemType)) {
      result.push('', '⚠️ 工具需要自定义 Tier（如 ModTiers.RUBY），请额外创建 Tier 枚举。');
    }
    if (itemType === 'armor') {
      result.push('', '⚠️ 盔甲需要自定义 ArmorMaterial，请额外创建盔甲材料。');
      result.push('', '📝 示例 ArmorMaterial 注册：');
      result.push('```java',
        'public static final ArmorMaterial RUBY = new ArmorMaterial(',
        '    Map.of(',
        '        ArmorType.BOOTS, 3,',
        '        ArmorType.LEGGINGS, 6,',
        '        ArmorType.CHESTPLATE, 8,',
        '        ArmorType.HELMET, 3',
        '    ),',
        '    15, SoundType.ARMOR_EQUIP_DIAMOND,',
        '    () -> Ingredient.of(ModItems.RUBY.get()),',
        '    List.of(new ArmorMaterial.Layer(Identifier.of("${modId}", "ruby"))),',
        '    0, 0',
        ');',
        '```');
    }

    return result.join('\n');
  },
});
