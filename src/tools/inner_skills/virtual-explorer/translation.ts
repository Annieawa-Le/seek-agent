/**
 * translation.ts — virtual-explorer 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'list_directory': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.path ?? '(?)') as string;
      return `列出目录: ${fp}`;
    },
    collapse: 'single',
  },
  'enter_subfolder': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const parent = (args?.parentPath ?? '(?)') as string;
      const folder = (args?.folderName ?? '(?)') as string;
      return `进入目录: ${parent}/${folder}`;
    },
    collapse: 'single',
  },
  'go_up': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const cur = (args?.currentPath ?? '(?)') as string;
      return `返回上级: ${cur}`;
    },
    collapse: 'single',
  },
  'virtual-explorer-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 virtual-explorer 技能说明',
    collapse: 'single',
  },

  // ── explorer-* 工具集 ──
  'explorer-list-directory': {
    icon: '■',
    category: 'read',
    callLabel: () => '列出当前目录',
    collapse: 'single',
  },
  'explorer-enter-subfolder': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const f = (args?.folderName ?? '(?)') as string;
      return `进入子目录: ${f}`;
    },
    collapse: 'single',
  },
  'explorer-go-up': {
    icon: '■',
    category: 'read',
    callLabel: () => '返回上级目录',
    collapse: 'single',
  },
  'explorer-read-file': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `读取文件: ${fp}`;
    },
    collapse: 'single',
  },
  'explorer-read-lines': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const s = args?.startLine ?? '?';
      const e = args?.endLine ?? '?';
      return `读取文件行: ${fp} (${s}-${e})`;
    },
    collapse: 'single',
  },
  'explorer-read-num-line': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const s = args?.startLine ?? '?';
      const e = args?.endLine ?? '?';
      return `读取文件(行号): ${fp} (${s}-${e})`;
    },
    collapse: 'single',
  },
  'explorer-scan-file': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `扫描文件: ${fp}`;
    },
    collapse: 'single',
  },
  'explorer-search-all-file': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const fn = (args?.fileName ?? '(?)') as string;
      return `搜索文件(递归): ${fp} (${fn})`;
    },
    collapse: 'after-round',
  },
  'explorer-search-sub-file': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const fn = (args?.fileName ?? '(?)') as string;
      return `搜索文件(当前): ${fp} (${fn})`;
    },
    collapse: 'after-round',
  },
  'explorer-search-directory': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `搜索目录: ${fp}`;
    },
    collapse: 'after-round',
  },
  'explorer-search-content': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const c = (args?.content ?? '(?)') as string;
      return `搜索内容: ${fp} (${c})`;
    },
    collapse: 'after-round',
  },
  'explorer-create-file': {
    icon: '■',
    category: 'file',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const fn = (args?.fileName ?? '(?)') as string;
      return `创建文件: ${fp}/${fn}`;
    },
    collapse: 'after-round',
  },
  'explorer-replace-file': {
    icon: '■',
    category: 'file',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `覆写文件: ${fp}`;
    },
    collapse: 'after-round',
  },
  'explorer-add-patch': {
    icon: '■',
    category: 'patch',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const line = args?.lineIndex ?? '?';
      return `暂存插入: ${fp} (行 ${line})`;
    },
    collapse: 'after-round',
  },
  'explorer-del-patch': {
    icon: '■',
    category: 'patch',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      return `暂存删除: ${fp}`;
    },
    collapse: 'after-round',
  },
  'explorer-modify-patch': {
    icon: '■',
    category: 'patch',
    callLabel: (args) => {
      const fp = (args?.filePath ?? '(?)') as string;
      const s = args?.startLine ?? '?';
      const e = args?.endLine ?? '?';
      return `暂存修改: ${fp} (行 ${s}-${e})`;
    },
    collapse: 'after-round',
  },
  'explorer-execute-command': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const cmd = (args?.command ?? '(?)') as string;
      const short = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
      return `执行命令: ${short}`;
    },
    collapse: 'after-round',
  },
};
export default translations;
