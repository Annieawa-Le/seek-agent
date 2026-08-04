/** 命令叠加层（command palette）的类型与默认命令清单 */

export interface PaletteItem {
  /** 唯一 id */
  id: string;
  /** 显示名称 */
  label: string;
  /** 分组名（如 "指令" / "工具" / "会话"） */
  group: string;
  /** 右侧快捷键提示（仅展示） */
  shortcut?: string;
  /** 执行动作 */
  run: () => void;
}

/** 按查询过滤命令：匹配 label 或 group（大小写不敏感） */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(it =>
    it.label.toLowerCase().includes(q) || it.group.toLowerCase().includes(q),
  );
}

/** 创建默认命令清单（TerminalUI 构造时初始化，外部可用 addPaletteItem 扩展） */
export function createDefaultPaletteItems(opts: {
  onSubmit: (text: string) => void;
  onCommand: (cmd: string) => void;
  onExit: () => void;
}): PaletteItem[] {
  const { onSubmit, onCommand, onExit } = opts;
  return [
    // ── 指令 ──
    { id: 'help', label: '帮助：查看全部指令', group: '指令', shortcut: '/help', run: () => onSubmit('/help') },
    { id: 'clear', label: '清空屏幕', group: '指令', shortcut: 'ctrl+l', run: () => onSubmit('/clear') },
    { id: 'save', label: '保存当前会话', group: '指令', shortcut: '/save', run: () => onSubmit('/save') },
    { id: 'mode', label: '切换 Agent 模式', group: '指令', shortcut: '/mode', run: () => onSubmit('/mode') },
    { id: 'exit', label: '退出 Seek Agent', group: '指令', shortcut: 'ctrl+d', run: () => onExit() },
    // ── 上下文 / 工具 ──
    { id: 'memory_shorten', label: '清理工具调用结果', group: '工具', shortcut: 'ctrl+q', run: () => onCommand('memory_shorten') },
    { id: 'memory_focus', label: '折叠 3 轮前的内容', group: '工具', shortcut: 'ctrl+w', run: () => onCommand('memory_focus') },
    { id: 'interrupt', label: '中断所有子 agent', group: '工具', shortcut: 'tab', run: () => onCommand('interrupt_agents') },
    { id: 'clear_input', label: '清空输入框', group: '工具', shortcut: 'ctrl+u', run: () => onSubmit('') },
  ];
}
