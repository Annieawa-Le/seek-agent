/**
 * translation.ts — image-identifier 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'image_info': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `图片信息: ${fp}`;
    },
    collapse: 'single',
  },
  'extract_image_text': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const lang = (args?.language ?? 'chi_sim+eng') as string;
      return `图片 OCR: ${fp} (${lang})`;
    },
    collapse: 'single',
  },
  'vision_analyze': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `视觉分析: ${fp}`;
    },
    collapse: 'single',
  },
  'image-identifier-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 image-identifier 技能说明',
    collapse: 'single',
  },
};
export default translations;
