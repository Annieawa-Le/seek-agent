/**
 * raw-bulk-formatters.ts — 三端格式化器
 *
 * 为每种 RawBulk 类型提供三个格式化函数：
 *   toAIText  → 给模型当 tool result（完整、干净、AI友好）
 *   toTUIText → 终端显示（带 ANSI 颜色、摘要、省略）
 *   toWebUI   → Electron 结构化数据
 */

import type { RawBulk, ReadFileBulk, SearchBulk, SearchContentBulk, ExecBulk, FileWriteBulk, PatchStagingBulk, DeskBulk } from './raw-bulk-types';

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

function formatPatchAIText(bulk: PatchStagingBulk): string {
  if (bulk.error) return `❌ 错误：${bulk.error}`;
  if (bulk.action === 'pop') {
    if (!bulk.description) return '■ 暂存区为空，没有可弹出的操作。';
    return `↩️ 已从暂存区弹出最近的一个操作：\n  📄 文件：${bulk.filePath}\n  ■ ${bulk.description}\n■ 暂存区还有 ${bulk.stagingSize} 个待应用的修改`;
  }
  if (bulk.action === 'check') {
    if (!bulk.patchDetail) return `❌ 序号超出范围`;
    return `📋 第 ${bulk.patchDetail.index} 个 patch 详情：\n工具: ${bulk.patchDetail.toolType}\n文件: ${bulk.filePath}\n描述: ${bulk.description}\n参数: ${JSON.stringify(bulk.patchDetail.params, null, 2)}\n\n📤 原始返回:\n${bulk.patchDetail.resultMessage || '(无原始返回记录)'}`;
  }
  if (bulk.action === 'ensure') {
    const lines: string[] = [];
    if (bulk.perFile) {
      for (const f of bulk.perFile) {
        lines.push(`📄 处理文件：${f.filePath}（${f.patchCount} 个补丁）`);
        lines.push(...f.results);
      }
    }
    lines.push('---');
    lines.push(`✅ 所有 ${bulk.applied} 个修改已成功应用`);
    return lines.join('\n');
  }
  if (bulk.action === 'revise') {
    return `✅ 已替换第 ${bulk.patchDetail?.index} 个 patch 为 ${bulk.description}\n■ 暂存区现有 ${bulk.stagingSize} 个待应用的修改`;
  }
  // add/del/modify
  return `${bulk.description}\n■ 操作尚未应用！请调用 ensure_patch 来确认或放弃。\n■ 暂存区现有 ${bulk.stagingSize} 个待应用的修改`;
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
// WebUI Renderer — 结构化数据给 Electron
// ═════════════════════════════════════════════════════

export function toWebUI(bulk: RawBulk): Record<string, unknown> {
  return bulk as unknown as Record<string, unknown>;
}




