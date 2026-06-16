/**
 * translation.ts — gh-explorer 工具友好调用翻译
 */
const translations: Record<string, {
  icon: string;
  category: 'read' | 'search' | 'exec' | 'file' | 'patch' | 'desk' | 'other';
  callLabel: (args: Record<string, unknown>) => string;
  collapse?: 'never' | 'single' | 'after-round';
}> = {
  'gh_search_repos': {
    icon: '■',
    category: 'search',
    callLabel: (args) => {
      const q = (args?.query ?? '(?)') as string;
      return `搜索仓库: ${q}`;
    },
    collapse: 'after-round',
  },
  'gh_repo_tree': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const url = (args?.repo_url ?? '(?)') as string;
      return `仓库目录树: ${url}`;
    },
    collapse: 'single',
  },
  'gh_readme': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const url = (args?.repo_url ?? '(?)') as string;
      return `查看 README: ${url}`;
    },
    collapse: 'single',
  },
  'gh_file_content': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const url = (args?.repo_url ?? '(?)') as string;
      const fp = (args?.file_path ?? '(?)') as string;
      return `查看文件: ${url} (${fp})`;
    },
    collapse: 'single',
  },
  'gh_explore': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const url = (args?.repo_url ?? '(?)') as string;
      return `探索仓库: ${url}`;
    },
    collapse: 'single',
  },
  'gh_clone': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const url = (args?.repo_url ?? '(?)') as string;
      const shallow = args?.shallow ? ' (浅)' : '';
      return `克隆仓库: ${url}${shallow}`;
    },
    collapse: 'after-round',
  },
  'gh_log': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const rp = (args?.repo_path ?? '(?)') as string;
      return `提交历史: ${rp}`;
    },
    collapse: 'single',
  },
  'gh_status': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const rp = (args?.repo_path ?? '(?)') as string;
      return `Git 状态: ${rp}`;
    },
    collapse: 'single',
  },
  'gh_branch': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const rp = (args?.repo_path ?? '(?)') as string;
      const action = (args?.action ?? 'list') as string;
      return `分支管理: ${rp} (${action})`;
    },
    collapse: 'after-round',
  },
  'gh_diff': {
    icon: '■',
    category: 'read',
    callLabel: (args) => {
      const rp = (args?.repo_path ?? '(?)') as string;
      const type = (args?.type ?? 'working') as string;
      return `查看差异: ${rp} (${type})`;
    },
    collapse: 'single',
  },
  'gh_checkout': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const rp = (args?.repo_path ?? '(?)') as string;
      const target = (args?.target ?? '(?)') as string;
      return `切换分支: ${rp} → ${target}`;
    },
    collapse: 'after-round',
  },
  'gh_push': {
    icon: '■',
    category: 'exec',
    callLabel: (args) => {
      const rp = (args?.repo_path ?? '(?)') as string;
      const branch = args?.branch ? ` (${args.branch})` : '';
      const force = args?.force ? ' (强制)' : '';
      return `推送: ${rp}${branch}${force}`;
    },
    collapse: 'after-round',
  },
  'gh-explorer-prompt-get': {
    icon: '■',
    category: 'read',
    callLabel: () => '查看 gh-explorer 技能说明',
    collapse: 'single',
  },
};
export default translations;
