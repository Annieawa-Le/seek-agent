/**
 * translation.ts — pdf-reader 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'read_pdf': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `读取 PDF: ${fp}`;
    },
    collapse: 'single',
  },
  'read_pdf_pages': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const start = args?.startPage ?? '?';
      const end = args?.endPage ?? '?';
      return `读取 PDF 页: ${fp} (${start}-${end})`;
    },
    collapse: 'single',
  },
  'pdf_info': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `PDF 元信息: ${fp}`;
    },
    collapse: 'single',
  },
  'pdf_extract_images': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `提取 PDF 图片: ${fp}`;
    },
    collapse: 'after-round',
  },
  'pdf_save_images': {
    icon: '■',
    category: 'file',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const dir = (args?.outputDir ?? '(?)') as string;
      return `保存 PDF 图片: ${fp} → ${dir}`;
    },
    collapse: 'after-round',
  },
  'pdf-reader-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 pdf-reader 技能说明',
    collapse: 'single',
  },
};
export default translations;
