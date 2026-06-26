/**
 * raw-bulk-formatters.ts — 三端格式化器
 *
 * 为每种 RawBulk 类型提供三个格式化函数：
 *   toAIText  → 给模型当 tool result（完整、干净、AI友好）
 *   toTUIText → 终端显示（带 ANSI 颜色、摘要、省略）
 *   toWebUI   → Electron 结构化数据
 */

import type { RawBulk, ReadFileBulk, SearchBulk, SearchContentBulk, ExecBulk, FileWriteBulk, PatchBulk, DeskBulk } from './raw-bulk-types';

// ═════════════════════════════════════════════════════
// AI Formatter — 保持现在对 AI 友好的格式，几乎不变
// ═════════════════════════════════════════════════════

export function toAIText(bulk: RawBulk): string {
  switch (bulk.type) {
    case 'read': return formatReadAIText(bulk);
    case 'search': return formatSearchAIText(bulk);
    case 'search-content': return formatSearchContentAIText(bulk);
    case 'exec': return formatExecAIText(bulk);
    case 'file-write': return formatFileWriteAIText(bulk);
    case 'patch': return formatPatchAIText(bulk);
    case 'desk': return formatDeskAIText(bulk);
    default: return JSON.stringify(bulk);
  }
}

function formatReadAIText(bulk: ReadFileBulk): string {
  if (bulk.error) return `命令执行失败: ${bulk.error}`;
  return bulk.content;
}

function formatSearchAIText(bulk: SearchBulk): string {
  if (bulk.error) return `读取文件失败: ${bulk.error}`;
  return JSON.stringify(bulk.results);
}

function formatSearchContentAIText(bulk: SearchContentBulk): string {
  if (bulk.error) return `读取或搜索文件失败: ${bulk.error}`;
  if (bulk.totalCount === 0) {
    return `未在文件 ${bulk.filePath} 中找到匹配内容"${bulk.pattern}"`;
  }
  return `在文件 ${bulk.filePath} 中找到 ${bulk.totalCount} 处匹配：\n` +
    bulk.matches.map(m => `${m.lineNum}: ${m.line}`).join('\n');
}

function formatExecAIText(bulk: ExecBulk): string {
  if (bulk.error) return `命令执行失败: ${bulk.error}`;
  let out = bulk.stdout;
  if (bulk.stderr) out += `\n[stderr]: ${bulk.stderr}`;
  return out;
}

function formatFileWriteAIText(bulk: FileWriteBulk): string {
  if (bulk.error) return `❌ ${bulk.action === 'create' ? '创建' : '写入'}失败：${bulk.error}`;
  if (bulk.action === 'create') {
    return `✅ 文件创建成功：${bulk.filePath}${bulk.fileName ? `/${bulk.fileName}` : ''}\n📝 写入内容长度：${bulk.charCount} 字符`;
  }
  return `✅ 写入成功：${bulk.filePath}\n📝 写入内容长度：${bulk.charCount} 字符`;
}

function formatPatchAIText(bulk: PatchBulk): string {
  if (bulk.error) return `❌ 错误：${bulk.error}`;
  switch (bulk.action) {
    case 'undo':
      return `↩️ 已撤销：[${bulk.description}]${bulk.filePath ? `\n  📄 ${bulk.filePath}` : ''}${bulk.diff ? `\n\n--- diff ---\n${bulk.diff}` : ''}`;
    case 'history':
      return bulk.description;
    // add / del / modify: AI text 已由工具本身返回，这里做兜底
    default:
      return `✅ [${bulk.action.toUpperCase()}] ${bulk.description}${bulk.filePath ? `\n📄 ${bulk.filePath}` : ''}${bulk.diff ? `\n\n--- diff ---\n${bulk.diff}` : ''}`;
  }
}

function formatDeskAIText(bulk: DeskBulk): string {
  if (bulk.error) return `⚠ ${bulk.error}`;
  switch (bulk.action) {
    case 'add': return `✅ 已将 ${bulk.filePath} 加入参考桌面`;
    case 'list': {
      if (bulk.totalCount === 0) return '📭 参考桌面上没有任何文件。';
      return `📋 参考桌面（共 ${bulk.totalCount} 项）：\n` +
        (bulk.entries || []).map((e, i) => `${i + 1}. ${e.filePath}（${e.charCount} 字符）`).join('\n');
    }
    case 'remove': return `✅ 已将 ${bulk.filePath} 从参考桌面移除。`;
    case 'clear': return `✅ 已清空参考桌面（移除了 ${bulk.totalCount} 项）。`;
  }
}

// ═════════════════════════════════════════════════════
// TUI Renderer — 带 ANSI 颜色、摘要、截断
// ═════════════════════════════════════════════════════

const BLUE_GRAY = '\x1b[38;2;112;128;144m';
const PURPLE = '\x1b[35m';

export function toTUIText(bulk: RawBulk): string {
  switch (bulk.type) {
    case 'read': return formatReadTUI(bulk);
    case 'search': return formatSearchTUI(bulk);
    case 'search-content': return formatSearchContentTUI(bulk);
    case 'exec': return formatExecTUI(bulk);
    case 'file-write': return bulk.error
      ? `❌ ${bulk.action === 'create' ? '创建' : '写入'}失败：${bulk.error}`
      : `● ${bulk.action === 'create' ? '创建文件' : '覆写文件'}: ${bulk.filePath}`;
    case 'patch': return bulk.description;
    case 'desk': return `● ${bulk.action === 'add' ? '添加到桌面' : bulk.action === 'remove' ? '从桌面移除' : bulk.action === 'clear' ? '清空桌面' : '查看桌面'}: ${bulk.totalCount} 项`;
    default: return JSON.stringify(bulk);
  }
}

function formatReadTUI(bulk: ReadFileBulk): string {
  if (bulk.error) return `● 命令执行失败: ${bulk.error}`;
  const maxPreview = 300;
  if (bulk.charCount <= maxPreview) {
    return `● ${bulk.content}`;
  }
  const lines = bulk.numberedLines || bulk.content.split('\n').map((c, i) => ({ lineNum: i + 1, content: c }));
  const totalLines = lines.length;
  const headCount = 5;
  const head = lines.slice(0, headCount).map(l => `  ${l.content}`).join('\n');
  const omitted = totalLines - headCount;
  return `● 共 ${PURPLE}${totalLines}\x1b[0m 行 / ${PURPLE}${bulk.charCount}\x1b[0m 字符\n${head}\n${BLUE_GRAY}  ... 其余 ${omitted} 行省略 ...\x1b[0m`;
}

function formatSearchTUI(bulk: SearchBulk): string {
  if (bulk.error) return `● 读取文件失败: ${bulk.error}`;
  if (bulk.totalCount === 0) return `●  未找到匹配结果`;
  const items = bulk.results.slice(0, 15).map(item => `  ${item.name}`).join('\n');
  const more = bulk.truncated ? `\n${BLUE_GRAY}  ... 还有 ${bulk.totalCount - 15} 个结果\x1b[0m` : '';
  return `●  找到 ${PURPLE}${bulk.totalCount}\x1b[0m 条结果\n${items}${more}`;
}

function formatSearchContentTUI(bulk: SearchContentBulk): string {
  if (bulk.error) return `● 读取或搜索文件失败: ${bulk.error}`;
  if (bulk.totalCount === 0) return `●  未在文件 ${bulk.filePath} 中找到匹配内容"${bulk.pattern}"`;
  const display = bulk.matches.map(m => `  ${m.lineNum}: ${m.line}`);
  if (display.length <= 12) return `● ${display.join('\n')}`;
  const head = display.slice(0, 8).join('\n');
  const remaining = display.length - 8;
  return `●  共 ${PURPLE}${bulk.totalCount}\x1b[0m 行匹配\n${head}\n${BLUE_GRAY}  ... 还有 ${remaining} 行 ...\x1b[0m`;
}

function formatExecTUI(bulk: ExecBulk): string {
  if (bulk.error) return `● 命令执行失败: ${bulk.error}`;
  const maxPreview = 300;
  const text = bulk.stdout + (bulk.stderr ? `\n[stderr]: ${bulk.stderr}` : '');
  if (text.length <= maxPreview) return `● ${text}`;
  const lines = text.split('\n');
  const head = lines.slice(0, 8).map(l => `  ${l}`).join('\n');
  return `●  输出 ${PURPLE}${lines.length}\x1b[0m 行 / ${PURPLE}${text.length}\x1b[0m 字符\n${head}\n${BLUE_GRAY}  ... 剩余 ${lines.length - 8} 行省略 ...\x1b[0m`;
}

// ═════════════════════════════════════════════════════
// WebUI Renderer — 生成 HTML 供 Electron 前端渲染
// ═════════════════════════════════════════════════════

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shortPath(fp: string): string {
  const parts = fp.split(/[/\\]/);
  return parts.length > 3 ? parts.slice(-3).join('/') : fp;
}

export function toWebUI(bulk: RawBulk): Record<string, unknown> {
  switch (bulk.type) {
    case 'read': return formatReadWebUI(bulk);
    case 'search': return formatSearchWebUI(bulk);
    case 'search-content': return formatSearchContentWebUI(bulk);
    case 'exec': return formatExecWebUI(bulk);
    case 'file-write': return formatFileWriteWebUI(bulk);
    case 'patch': return formatPatchWebUI(bulk);
    case 'desk': return formatDeskWebUI(bulk);
    default: return { html: `<pre>${esc(JSON.stringify(bulk))}</pre>` };
  }
}

// ── ReadFileBulk ──
function formatReadWebUI(bulk: ReadFileBulk): Record<string, unknown> {
  if (bulk.error) {
    return { html: `<div class="error">${esc(bulk.error)}</div>` };
  }
  const meta = `<div class="meta">${esc(bulk.filePath)} &nbsp;·&nbsp; ${bulk.lineCount} 行 / ${bulk.charCount} 字符</div>`;
  if (bulk.numberedLines) {
    const rows = bulk.numberedLines.map(l =>
      `<div class="line"><span class="line-num">${l.lineNum}</span><span class="line-content">${esc(l.content)}</span></div>`
    ).join('');
    return { html: `<div class="read-result">${meta}${rows}</div>` };
  }
  const lines = bulk.content.split('\n');
  const rows = lines.map((line, i) =>
    `<div class="line"><span class="line-num">${i + 1}</span><span class="line-content">${esc(line)}</span></div>`
  ).join('');
  return { html: `<div class="read-result">${meta}${rows}</div>` };
}

// ── SearchBulk ──
function formatSearchWebUI(bulk: SearchBulk): Record<string, unknown> {
  if (bulk.error) return { html: `<div class="error">${esc(bulk.error)}</div>` };
  if (bulk.totalCount === 0) return { html: '<div class="empty">未找到匹配结果</div>' };
  const items = bulk.results.slice(0, 30).map(r =>
    `<div class="search-item"><span class="name">${esc(r.name)}</span><span class="path">${esc(r.path)}</span></div>`
  ).join('');
  const more = bulk.truncated ? `<div class="more">… 还有 ${bulk.totalCount - 30} 个结果</div>` : '';
  return { html: `<div class="search-result"><div class="meta">找到 ${bulk.totalCount} 条结果</div>${items}${more}</div>` };
}

// ── SearchContentBulk ──
function formatSearchContentWebUI(bulk: SearchContentBulk): Record<string, unknown> {
  if (bulk.error) return { html: `<div class="error">${esc(bulk.error)}</div>` };
  if (bulk.totalCount === 0) {
    return { html: `<div class="empty">未在 ${esc(bulk.filePath)} 中找到匹配内容</div>` };
  }
  const matches = bulk.matches.slice(0, 50).map(m =>
    `<div class="match-line"><span class="line-num">${m.lineNum}</span><code>${esc(m.line)}</code></div>`
  ).join('');
  const more = bulk.totalCount > 50 ? `<div class="more">… 还有 ${bulk.totalCount - 50} 行匹配</div>` : '';
  return { html: `<div class="search-content-result">${esc(bulk.filePath)}（共 ${bulk.totalCount} 处匹配）${matches}${more}</div>` };
}

// ── ExecBulk ──
function formatExecWebUI(bulk: ExecBulk): Record<string, unknown> {
  if (bulk.error) {
    return { html: `<div class="exec-stderr">${esc(bulk.error)}</div>` };
  }
  let html = `<pre class="exec-output">${esc(bulk.stdout)}</pre>`;
  if (bulk.stderr) html += `<pre class="exec-stderr">${esc(bulk.stderr)}</pre>`;
  return { html };
}

// ── FileWriteBulk ──
function formatFileWriteWebUI(bulk: FileWriteBulk): Record<string, unknown> {
  if (bulk.error) return { html: `<div class="error">${esc(bulk.error)}</div>` };
  const label = bulk.action === 'create' ? '创建文件' : '覆写文件';
  const path = bulk.fileName ? `${esc(bulk.filePath)}/${esc(bulk.fileName)}` : esc(bulk.filePath);
  return { html: `<div class="file-write"><span class="label">${label}</span><code>${path}</code><span class="meta">${bulk.charCount} 字符</span></div>` };
}

// ── PatchBulk ──
function formatPatchWebUI(bulk: PatchBulk): Record<string, unknown> {
  if (bulk.error) return { html: `<div class="error">${esc(bulk.error)}</div>` };
  switch (bulk.action) {
    case 'add': case 'del': case 'modify':
      return {
        html: `<div class="patch-result"><span class="label">[${bulk.action.toUpperCase()}]</span> ${esc(bulk.description)}<br><pre>${esc(bulk.diff || '')}</pre></div>`
      };
    case 'undo':
      return {
        html: `<div class="patch-result"><span class="label">UNDO</span> ${esc(bulk.description)}<br><pre>${esc(bulk.diff || '')}</pre></div>`
      };
    case 'history':
      return { html: `<div class="patch-result"><pre>${esc(bulk.description)}</pre></div>` };
    default: return { html: `<pre>${esc(JSON.stringify(bulk))}</pre>` };
  }
}

// ── DeskBulk ──
function formatDeskWebUI(bulk: DeskBulk): Record<string, unknown> {
  if (bulk.error) return { html: `<div class="error">${esc(bulk.error)}</div>` };
  switch (bulk.action) {
    case 'add':
      return { html: `<div class="desk-result"><span class="label">添加到桌面</span><code>${esc(bulk.filePath || '')}</code></div>` };
    case 'list':
      if (!bulk.entries || bulk.entries.length === 0) return { html: '<div class="empty">参考桌面为空</div>' };
      const entries = bulk.entries.map(e => `<div><code>${esc(e.filePath)}</code>（${e.charCount} 字符）</div>`).join('');
      return { html: `<div class="desk-result"><span class="label">参考桌面（共 ${bulk.totalCount} 项）</span><div class="desk-entries">${entries}</div></div>` };
    case 'remove':
      return { html: `<div class="desk-result"><span class="label">从桌面移除</span><code>${esc(bulk.filePath || '')}</code></div>` };
    case 'clear':
      return { html: `<div class="desk-result"><span class="label">清空桌面</span><span class="meta">移除了 ${bulk.totalCount} 项</span></div>` };
    default: return { html: `<pre>${esc(JSON.stringify(bulk))}</pre>` };
  }
}









