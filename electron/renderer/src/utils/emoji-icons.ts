/**
 * emoji-icons.ts — 工具结果里的 emoji → 内联 SVG 图标
 *
 * 工具结果的文本里带着 ✅/❌/📋 这类 emoji（模型要读、终端也要显示），
 * 但 WebUI 用系统 emoji 字体渲染时风格杂乱、行高也对不齐。
 * 这里在渲染层做一次替换：数据侧（AI 文本 / toWebUI HTML）保持原样不动，
 * 只在喂给 dangerouslySetInnerHTML 之前把 emoji 换成同色描边 SVG。
 *
 * 未登记的 emoji 原样保留，新增图标只需往 ICONS 里加一条。
 */

interface IconDef {
  /** SVG 内容体 */
  body: string;
  /** 语义色类名：ok / err / warn / dim / run（默认继承文字色） */
  tone?: 'ok' | 'err' | 'warn' | 'dim' | 'run';
}

const ICONS: Record<string, IconDef> = {
  // ── 状态 ──
  '✅': { tone: 'ok', body: '<polyline points="20 6 9 17 4 12"/>' },
  '❌': { tone: 'err', body: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' },
  '⚠': { tone: 'warn', body: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
  '⛔': { tone: 'err', body: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>' },
  '⏳': { tone: 'warn', body: '<path d="M6 2h12"/><path d="M6 22h12"/><path d="M6 2v4a6 6 0 0 0 6 6 6 6 0 0 0 6-6V2"/><path d="M6 22v-4a6 6 0 0 1 6-6 6 6 0 0 1 6 6v4"/>' },
  '⏸': { tone: 'dim', body: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>' },

  // ── 列表 / 文件 ──
  '📋': { body: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>' },
  '📄': { body: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
  '📜': { body: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
  '📝': { body: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>' },
  '📭': { tone: 'dim', body: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>' },
  '📦': { body: '<path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>' },
  '📨': { body: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22,6 12,13 2,6"/>' },

  // ── 运行 / 任务 ──
  '🔄': { tone: 'run', body: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>' },
  '⏹': { tone: 'dim', body: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>' },
  '🚀': { body: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>' },
  '📡': { tone: 'run', body: '<path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/>' },
  '⏰': { body: '<circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><line x1="5" y1="3" x2="2" y2="6"/><line x1="19" y1="3" x2="22" y2="6"/>' },
  '🎯': { body: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>' },
  '🚩': { body: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>' },
  '↩': { tone: 'dim', body: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>' },
  '🔍': { body: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' },
  '↳': { tone: 'dim', body: '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>' },
  '💡': { body: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>' },

  // ── 复选框 / 项目符号 ──
  '⬜': { tone: 'dim', body: '<rect x="4" y="4" width="16" height="16" rx="2"/>' },
  '■': { tone: 'dim', body: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>' },

  // ── 其它 ──
  '🗑': { tone: 'dim', body: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' },
  '💾': { tone: 'dim', body: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>' },
  '📊': { body: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>' },
  '⏭': { tone: 'dim', body: '<polygon points="5 4 15 12 5 20 5 4" fill="currentColor" stroke="none"/><line x1="19" y1="5" x2="19" y2="19"/>' },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** emoji 匹配：允许尾随的变体选择符（U+FE0F），如 "⚠️" 与 "⚠" 都命中同一条 */
const EMOJI_RE = new RegExp(`(${Object.keys(ICONS).map(escapeRegExp).join('|')})\\uFE0F?`, 'g');

function iconHtml(def: IconDef): string {
  const cls = def.tone ? `tr-icon tr-icon-${def.tone}` : 'tr-icon';
  return `<svg class="${cls}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def.body}</svg>`;
}

/** 把 HTML 片段里已登记的 emoji 换成内联 SVG（未登记的字符原样保留） */
export function replaceEmojiWithSvg(html: string): string {
  if (!html) return html;
  return html.replace(EMOJI_RE, (match, ch: string) => {
    const def = ICONS[ch];
    return def ? iconHtml(def) : match;
  });
}
