/**
 * translation.ts — image-crawler 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'extract_images': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const url = (args?.url ?? '(?)') as string;
      return `提取图片: ${url}`;
    },
    collapse: 'after-round',
  },
  'filter_images': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const kw = (args?.keyword ?? '') as string;
      return `筛选图片${kw ? `: ${kw}` : ''}`;
    },
    collapse: 'after-round',
  },
  'download_images': {
    icon: '■',
    category: 'file',
    callLabel: (args) => {
      const dir = (args?.output_dir ?? '(?)') as string;
      return `下载图片: ${dir}`;
    },
    collapse: 'after-round',
  },
  'image-crawler-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 image-crawler 技能说明',
    collapse: 'single',
  },
};
export default translations;
