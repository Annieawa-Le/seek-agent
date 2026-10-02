/* ═══════════════════════════════════════════════════════════
   展示层的小格式化工具：路径、时间、标签文案。
   编辑器、标签栏、审查浮球共用同一套写法，避免「同一个文件在几处
   显示成不同名字」这类不一致。
   ═══════════════════════════════════════════════════════════ */

/** patch 类型 → 中文标签 */
export const TYPE_LABEL: Record<string, string> = {
  add: '新增', del: '删除', modify: '修改', replace: '覆写', batch: '批量',
};

/** 路径末段（文件名 / 标签标题） */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

/** 精简显示路径：保留末两段，过深时以 … 折叠 */
export function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
}

/** 时间戳 → HH:MM:SS */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
