/**
 * translation.ts — skill-creator 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'create_skill': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const name = (args?.skillName ?? '(?)') as string;
      return `创建技能: ${name}`;
    },
    collapse: 'after-round',
  },
  'list_skills': {
    icon: '■',
    category: 'read',
    callLabel: () => '列出所有技能',
    collapse: 'single',
  },
  'skill-creator-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 skill-creator 技能说明',
    collapse: 'single',
  },
};
export default translations;
