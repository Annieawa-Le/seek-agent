/**
 * translation.ts — mc-mod-helper 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'mc_project_scaffold': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const modId = (args?.modId ?? '(?)') as string;
      return `创建 MC 模组项目: ${modId}`;
    },
    collapse: 'after-round',
  },
  'mc_register_item': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const name = (args?.itemName ?? '(?)') as string;
      return `注册物品: ${name}`;
    },
    collapse: 'after-round',
  },
  'mc_register_block': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const name = (args?.blockName ?? '(?)') as string;
      return `注册方块: ${name}`;
    },
    collapse: 'after-round',
  },
  'mc_gen_recipe': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const id = (args?.recipeId ?? '(?)') as string;
      return `生成合成表: ${id}`;
    },
    collapse: 'after-round',
  },
  'mc_gen_lang': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const key = (args?.translationKey ?? '(?)') as string;
      return `生成语言文件: ${key}`;
    },
    collapse: 'after-round',
  },
  'mc_gen_model': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const id = (args?.itemId ?? args?.blockId ?? '(?)') as string;
      return `生成模型文件: ${id}`;
    },
    collapse: 'after-round',
  },
  'mc_gen_loot_table': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const id = (args?.blockId ?? '(?)') as string;
      return `生成战利品表: ${id}`;
    },
    collapse: 'after-round',
  },
  'mc-mod-helper-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 mc-mod-helper 技能说明',
    collapse: 'single',
  },
};
export default translations;
