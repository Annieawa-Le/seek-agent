/**
 * translation.ts — desk-editor 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'desk_edit': {
    icon: '■',
    category: 'desk',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `桌面编辑: ${fp}`;
    },
    collapse: 'after-round',
  },
  'line_cursor': {
    icon: '■',
    category: 'desk',
    callLabel: (args) => {
      const line = args?.line ?? '?';
      return `光标定位: 行 ${line}`;
    },
    collapse: 'single',
  },
  'line_paste': {
    icon: '■',
    category: 'desk',
    callLabel: () => '粘贴内容到光标处',
    collapse: 'after-round',
  },
  'ctrl_z': {
    icon: '■',
    category: 'desk',
    callLabel: (args) => {
      const id = args?.id ?? '(?)';
      return `撤销: ${id}`;
    },
    collapse: 'after-round',
  },
  'desk_save': {
    icon: '■',
    category: 'desk',
    callLabel: () => '保存桌面编辑',
    collapse: 'after-round',
  },
  'desk_cancel': {
    icon: '■',
    category: 'desk',
    callLabel: () => '取消桌面编辑',
    collapse: 'after-round',
  },
  'desk_confirm_file': {
    icon: '■',
    category: 'desk',
    callLabel: (args) => {
      const id = args?.id ?? '(全部)';
      return `确认文件钉扎: ${id}`;
    },
    collapse: 'after-round',
  },
  'desk-editor-prompt-get': {
    icon: '■',
    category: 'desk',
    callLabel: () => '查看 desk-editor 技能说明',
    collapse: 'single',
  },
};
export default translations;
