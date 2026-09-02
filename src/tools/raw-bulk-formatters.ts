/**
 * raw-bulk-formatters.ts — 三端格式化器
 *
 * 为每种 RawBulk 类型提供三个格式化函数：
 *   toAIText  → 给模型当 tool result（完整、干净、AI友好）
 *   toTUIText → 终端显示（带 ANSI 颜色、摘要、省略）
 *   toWebUI   → Electron 结构化数据
 */
import type { RawBulk, ReadFileBulk, SearchBulk, SearchContentBulk, ExecBulk, FileWriteBulk, PatchBulk, DeskBulk, TaskBulk, TodoBulk, MemoryBulk } from './raw-bulk-types';


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
    case 'task': return formatTaskAIText(bulk);
    case 'todo': return formatTodoAIText(bulk);
    case 'memory': return formatMemoryAIText(bulk);
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
  if (bulk.deferred) {
    const secs = bulk.timeoutMs ? Math.round(bulk.timeoutMs / 1000) : 60;
    return `命令执行超过 ${secs} 秒未结束，已转入后台任务 "${bulk.taskName}"。可继续用 task_switch(taskName="${bulk.taskName}") 查看输出、task_kill(taskName="${bulk.taskName}") 终止。`;
  }
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

function formatTaskAIText(bulk: TaskBulk): string {
  if (bulk.error) return `❌ ${bulk.error}`;
  switch (bulk.action) {
    case 'list': {
      if (!bulk.tasks || bulk.tasks.length === 0) return '📭 当前没有任何后台任务。';
      return `📋 后台任务（共 ${bulk.tasks.length} 个）：\n` +
        bulk.tasks.map((t, i) => {
          const icon = t.running ? '🔄' : t.status === 'done' ? '✅' : t.status === 'killed' ? '⏹' : '❌';
          return `${i + 1}. ${icon} ${t.name} [${t.status}]（${t.durationMs != null ? (t.durationMs / 1000).toFixed(1) : '?'}s${t.exitCode != null ? `，退出码 ${t.exitCode}` : ''}，输出 ${t.stdoutChars + t.stderrChars} 字符）\n    ↳ ${t.command}`;
        }).join('\n');
    }
    case 'execute':
      return `🚀 后台任务已启动：${bulk.taskName}（${bulk.status}${bulk.pid != null ? `，PID ${bulk.pid}` : ''}）\n命令：${bulk.command}`;
    case 'switch': {
      const head = `📡 任务 "${bulk.taskName}"：${bulk.status}${bulk.exitCode != null ? `（退出码 ${bulk.exitCode}）` : ''}，stdout ${bulk.stdoutChars ?? 0} 字符`;
      return bulk.output ? `${head}\n--- 输出（${bulk.outputTruncated ? '尾部截断' : '全部'}）---\n${bulk.output}` : head;
    }
    case 'kill':
      return `⏹ 已发送终止信号给任务 "${bulk.taskName}"。`;
    default:
      return JSON.stringify(bulk);
  }
}


function formatTodoAIText(bulk: TodoBulk): string {
  if (bulk.error) return `❌ 错误：${bulk.error}`;
  const stepsText = (bulk.steps || []).map((s, i) => {
    const status = s.completed ? '✅' : '⬜';
    return `  ${status} Step ${i + 1}: ${s.content}`;
  }).join('\n');
  let head = '';
  switch (bulk.action) {
    case 'create': head = `✅ 已创建 todo "${bulk.name}"（共 ${bulk.totalCount} 步）：`; break;
    case 'finish': head = `✅ Step 完成：${bulk.stepInfo || ''}`; break;
    case 'undo': head = `↩️ 已撤销 Step：${bulk.stepInfo || ''}`; break;
    case 'reroll': head = `🔄 已重置 "${bulk.name}" 的所有步骤为未完成。`; break;
    case 'del-step': head = `■ 已删除 Step：${bulk.stepInfo || ''}`; break;
    case 'read': head = `📋 "${bulk.name}"（${bulk.doneCount}/${bulk.totalCount} 步完成）：`; break;
    case 'del': head = `■ 已删除 todo "${bulk.name}"。`; break;
    case 'active': head = bulk.active ? `🎯 当前活跃 todo："${bulk.active}"` : '■ 当前没有设置活跃 todo。'; break;
    case 'finish-to': head = `🎯 完成到指定步骤：${bulk.stepInfo || ''}`; break;
  }
  return stepsText ? `${head}\n${stepsText}` : head;
}

function formatMemoryAIText(bulk: MemoryBulk): string {
  if (bulk.error) return `❌ 错误：${bulk.error}`;
  if (bulk.action === 'focus') {
    return [`✅ 已将 ${bulk.roundsCompressed} 轮旧对话压缩为工作梗概。`, bulk.messagesRemoved !== undefined ? `移除了 ${bulk.messagesRemoved} 条消息，插入 ${bulk.messageInserted ?? 1} 条 [Work Log]。` : '', '', bulk.summary || ''].join('\n');
  }
  if (bulk.action === 'shorten') {
    return [`✅ 已将 ${bulk.roundsCompressed} 轮旧对话中的 ${bulk.resultsShortened ?? 0} 个工具返回结果精简为 "success"。`].join('\n');
  }
  // 对话记忆操作：优先返回结果列表，否则返回内容/跳过原因
  if (bulk.results?.length) {
    return bulk.results.map((r, i) => `${i + 1}. ${r.content}${r.score != null ? `（相似度 ${(r.score * 100).toFixed(0)}%）` : ''}`).join('\n');
  }
  return bulk.content || bulk.skipReason || `操作完成（${bulk.action}）。`;
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
    case 'desk': return `● ${bulk.action === 'add' ? '添加到桌面' : bulk.action === 'remove' ? '从桌面移除' : bulk.action === 'clear' ? '清空桌面' : '查看桌面'}: ${bulk.totalCount} 项`;
    case 'task': return formatTaskTUI(bulk);
    case 'todo': return formatTodoTUI(bulk);
    case 'memory': return formatMemoryTUI(bulk);
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
  const items = bulk.results.map(item => `  ${item.name}${item.isDir ? '/' : ''}`).join('\n');
  const more = bulk.truncated ? `\n${BLUE_GRAY}  ... 还有 ${Math.max(0, bulk.totalCount - bulk.results.length)} 个结果\x1b[0m` : '';
  return `●  找到 ${PURPLE}${bulk.totalCount}\x1b[0m 条结果\n${items}${more}`;
}

function formatSearchContentTUI(bulk: SearchContentBulk): string {
  if (bulk.error) return `● 读取或搜索文件失败: ${bulk.error}`;
  if (bulk.totalCount === 0) return `●  未在 ${bulk.filePath} 中找到匹配内容"${bulk.pattern}"`;
  const display = bulk.matches.map(m => m.filePath ? `  ${m.filePath}:${m.lineNum}: ${m.line}` : `  ${m.lineNum}: ${m.line}`);
  if (display.length <= 12 && !bulk.truncated) return `● ${display.join('\n')}`;
  const head = display.slice(0, 8).join('\n');
  const tail = bulk.truncated ? `${BLUE_GRAY}  ... 结果已截断，共 ${bulk.totalCount} 行\x1b[0m` : `${BLUE_GRAY}  ... 还有 ${display.length - 8} 行 ...\x1b[0m`;
  return `●  共 ${PURPLE}${bulk.totalCount}\x1b[0m 行匹配\n${head}\n${tail}`;
}
function formatExecTUI(bulk: ExecBulk): string {
  if (bulk.deferred) {
    const secs = bulk.timeoutMs ? Math.round(bulk.timeoutMs / 1000) : 60;
    return `● 命令超过 ${PURPLE}${secs}\x1b[0m 秒未结束，已转入后台任务 "${bulk.taskName}"，可 task_switch / task_kill 管理`;
  }
  if (bulk.error) return `● 命令执行失败: ${bulk.error}`;
  const maxPreview = 300;
  const text = bulk.stdout + (bulk.stderr ? `\n[stderr]: ${bulk.stderr}` : '');
  if (text.length <= maxPreview) return `● ${text}`;
  const lines = text.split('\n');
  const head = lines.slice(0, 8).map(l => `  ${l}`).join('\n');
  return `●  输出 ${PURPLE}${lines.length}\x1b[0m 行 / ${PURPLE}${text.length}\x1b[0m 字符\n${head}\n${BLUE_GRAY}  ... 剩余 ${lines.length - 8} 行省略 ...\x1b[0m`;
}

function formatTaskTUI(bulk: TaskBulk): string {
  if (bulk.error) return `● 错误: ${bulk.error}`;
  if (bulk.action === 'list') {
    const running = (bulk.tasks || []).filter(t => t.running).length;
    return `● 后台任务: ${PURPLE}${bulk.tasks?.length ?? 0}\x1b[0m 个（运行中 ${PURPLE}${running}\x1b[0m）`;
  }
  if (bulk.action === 'kill') return `● 停止任务: ${bulk.taskName}`;
  if (bulk.action === 'execute') return `● 后台启动: ${bulk.taskName}${bulk.pid != null ? ` (PID ${bulk.pid})` : ''}`;
  // switch
  const status = bulk.status ?? '?';
  const head = `● 任务 ${bulk.taskName}: ${status}${bulk.exitCode != null ? ` (码 ${bulk.exitCode})` : ''}`;
  if (!bulk.output) return head;
  const lines = bulk.output.split('\n');
  const headLines = lines.slice(0, 6).map(l => `  ${l}`).join('\n');
  const more = lines.length > 6 ? `\n${BLUE_GRAY}  ... 尾部共 ${bulk.stdoutChars ?? lines.join('\n').length} 字符，已截断 ...\x1b[0m` : '';
  return `${head}\n${headLines}${more}`;
}


function formatTodoTUI(bulk: TodoBulk): string {
  if (bulk.error) return `● 错误: ${bulk.error}`;
  const done = bulk.doneCount;
  const total = bulk.totalCount;
  const actionLabel: Record<string, string> = {
    create: '创建 todo', finish: '完成步骤', undo: '撤销步骤', reroll: '重置 todo',
    'del-step': '删除步骤', read: '查看 todo', del: '删除 todo', active: '活跃 todo', 'finish-to': '跳转进度',
  };
  const label = actionLabel[bulk.action] || bulk.action;
  return `● ${label}: ${PURPLE}${bulk.name}\x1b[0m（${done}/${total} 步）`;
}

function formatMemoryTUI(bulk: MemoryBulk): string {
  if (bulk.error) return `● 错误: ${bulk.error}`;
  if (bulk.action === 'focus') {
    return `● 已压缩 ${PURPLE}${bulk.roundsCompressed}\x1b[0m 轮对话为工作梗概`;
  }
  if (bulk.action === 'shorten') {
    return `● 已精简 ${PURPLE}${bulk.roundsCompressed}\x1b[0m 轮中的 ${bulk.resultsShortened ?? 0} 个工具结果`;
  }
  const label: Record<string, string> = {
    add: '新增工作记忆', update: '更新工作记忆', touch: '续命工作记忆',
    remove: '删除工作记忆', list: '查看工作记忆', clear: '清空记忆',
    remember: '写入长期记忆', recall: '检索长期记忆', stats: '记忆概览',
  };
  const head = `● ${label[bulk.action] || bulk.action}`;
  if (bulk.results?.length) {
    const lines = bulk.results.slice(0, 5).map((r) => `  ${r.content}${r.score != null ? `（${(r.score * 100).toFixed(0)}%）` : ''}`).join('\n');
    const more = bulk.results.length > 5 ? `\n${BLUE_GRAY}  ... 共 ${bulk.results.length} 条\x1b[0m` : '';
    return `${head}\n${lines}${more}`;
  }
  return bulk.skipped ? `● ${bulk.skipReason || '重复，已跳过'}` : `${head}: ${bulk.itemCount ?? ''}`.trim();
}

// ═════════════════════════════════════════════════════
// WebUI Renderer — 生成 HTML 供 Electron 前端渲染
// ═════════════════════════════════════════════════════

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


export function toWebUI(bulk: RawBulk): Record<string, unknown> {
  switch (bulk.type) {
    case 'read': return formatReadWebUI(bulk);
    case 'task': return formatTaskWebUI(bulk);
    case 'search': return formatSearchWebUI(bulk);
    case 'search-content': return formatSearchContentWebUI(bulk);
    case 'exec': return formatExecWebUI(bulk);
    case 'file-write': return formatFileWriteWebUI(bulk);
    case 'patch': return formatPatchWebUI(bulk);
    case 'desk': return formatDeskWebUI(bulk);
    case 'todo': return formatTodoWebUI(bulk);
    case 'memory': return formatMemoryWebUI(bulk);
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
    `<div class="search-item"><span class="name">${esc(r.name)}${r.isDir ? '/' : ''}</span><span class="path">${esc(r.path)}</span></div>`
  ).join('');
  const more = bulk.truncated ? `<div class="more">… 还有 ${Math.max(0, bulk.totalCount - bulk.results.length)} 个结果</div>` : '';
  return { html: `<div class="search-result"><div class="meta">找到 ${bulk.totalCount} 条结果</div>${items}${more}</div>` };
}

// ── SearchContentBulk ──
function formatSearchContentWebUI(bulk: SearchContentBulk): Record<string, unknown> {
  if (bulk.error) return { html: `<div class="error">${esc(bulk.error)}</div>` };
  if (bulk.totalCount === 0) {
    return { html: `<div class="empty">未在 ${esc(bulk.filePath)} 中找到匹配内容</div>` };
  }
  const matches = bulk.matches.slice(0, 50).map(m =>
    `<div class="match-line"><span class="line-num">${m.filePath ? esc(m.filePath) + ':' : ''}${m.lineNum}</span><code>${esc(m.line)}</code></div>`
  ).join('');
  const more = bulk.truncated ? `<div class="more">… 结果已截断，共 ${bulk.totalCount} 行</div>` : '';
  return { html: `<div class="search-content-result">${esc(bulk.filePath)}（${bulk.truncated ? '已截断，共 ' + bulk.totalCount + ' 处' : '共 ' + bulk.totalCount + ' 处匹配'}）${matches}${more}</div>` };
}
// ── ExecBulk ──
function formatExecWebUI(bulk: ExecBulk): Record<string, unknown> {
  if (bulk.deferred) {
    const secs = bulk.timeoutMs ? Math.round(bulk.timeoutMs / 1000) : 60;
    return {
      html: `<div class="exec-deferred">⏳ 命令执行超过 ${secs} 秒未结束，已转入后台任务 <code>${esc(bulk.taskName ?? '')}</code>，可用 task_switch / task_kill 管理</div>`
    };
  }
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

// ── TaskBulk ──
function formatTaskWebUI(bulk: TaskBulk): Record<string, unknown> {
  if (bulk.error) return { html: `<div class="error">${esc(bulk.error)}</div>` };
  if (bulk.action === 'list') {
    if (!bulk.tasks || bulk.tasks.length === 0) return { html: '<div class="empty">当前没有任何后台任务</div>' };
    const rows = bulk.tasks.map(t => {
      const icon = t.running ? '🔄' : t.status === 'done' ? '✅' : t.status === 'killed' ? '⏹' : '❌';
      const dur = t.durationMs != null ? (t.durationMs / 1000).toFixed(1) + 's' : '?';
      return `<div class="task-row"><span class="task-status">${icon}</span><code>${esc(t.name)}</code><span class="task-meta">${t.status} · ${dur}${t.exitCode != null ? ` · 退出码 ${t.exitCode}` : ''} · 输出 ${t.stdoutChars + t.stderrChars} 字符</span><div class="task-cmd">${esc(t.command)}</div></div>`;
    }).join('');
    return { html: `<div class="task-result"><span class="label">后台任务（共 ${bulk.tasks.length} 个）</span>${rows}</div>` };
  }
  if (bulk.action === 'kill') {
    return { html: `<div class="task-result"><span class="label">停止任务</span><code>${esc(bulk.taskName || '')}</code></div>` };
  }
  if (bulk.action === 'execute') {
    return { html: `<div class="task-result"><span class="label">后台启动</span><code>${esc(bulk.taskName || '')}</code><span class="meta">${esc(bulk.command || '')}</span></div>` };
  }
  // switch
  const statusHtml = `<span class="task-status">${bulk.status ?? '?'}${bulk.exitCode != null ? `（退出码 ${bulk.exitCode}）` : ''}</span>`;
  const out = bulk.output ? `<pre class="exec-output">${esc(bulk.output)}</pre>` : '<div class="empty">暂无输出</div>';
  return { html: `<div class="task-result"><span class="label">任务 ${esc(bulk.taskName || '')}</span>${statusHtml}<span class="meta">stdout ${bulk.stdoutChars ?? 0} 字符${bulk.outputTruncated ? '（尾部截断）' : ''}</span>${out}</div>` };
}


// ── TodoBulk ──
function formatTodoWebUI(bulk: TodoBulk): Record<string, unknown> {
  if (bulk.error) return { html: `<div class="error">${esc(bulk.error)}</div>` };
  const actionLabel: Record<string, string> = {
    create: '创建 todo', finish: '完成步骤', undo: '撤销步骤', reroll: '重置 todo',
    'del-step': '删除步骤', read: '查看 todo', del: '删除 todo', active: '活跃 todo', 'finish-to': '跳转进度',
  };
  const label = actionLabel[bulk.action] || bulk.action;
  let head = `<span class="label">${label}</span><span class="meta">${bulk.doneCount}/${bulk.totalCount} 步完成</span>`;
  if (bulk.active) head += `<code>当前活跃：${esc(bulk.active)}</code>`;
  const steps = (bulk.steps || []).map(s =>
    `<div class="todo-step ${s.completed ? 'done' : ''}"><span class="todo-status">${s.completed ? '✅' : '⬜'}</span>${esc(s.content)}</div>`
  ).join('');
  return { html: `<div class="todo-result"><div class="todo-head"><span class="todo-name">${esc(bulk.name)}</span>${head}</div>${steps}</div>` };
}

// ── MemoryBulk ──
function formatMemoryWebUI(bulk: MemoryBulk): Record<string, unknown> {
  if (bulk.error) return { html: `<div class="error">${esc(bulk.error)}</div>` };
  if (bulk.action === 'focus') {
    const summary = bulk.summary ? `<pre class="memory-summary">${esc(bulk.summary)}</pre>` : '';
    return { html: `<div class="memory-result"><span class="label">记忆压缩</span><span class="meta">${bulk.roundsCompressed} 轮 → ${esc(String(bulk.messagesRemoved ?? ''))} 条移除 / ${esc(String(bulk.messageInserted ?? 1))} 条梗概</span>${summary}</div>` };
  }
  if (bulk.action === 'shorten') {
    return { html: `<div class="memory-result"><span class="label">记忆精简</span><span class="meta">${bulk.roundsCompressed} 轮 / ${bulk.resultsShortened ?? 0} 个结果 → success</span></div>` };
  }
  const labelMap: Record<string, string> = {
    add: '新增工作记忆', update: '更新工作记忆', touch: '续命工作记忆',
    remove: '删除工作记忆', list: '查看工作记忆', clear: '清空记忆',
    remember: '写入长期记忆', recall: '检索长期记忆', stats: '记忆概览',
  };
  const label = labelMap[bulk.action] || bulk.action;
  let body = '';
  if (bulk.results?.length) {
    body = `<pre class="memory-results">${bulk.results.map((r) => esc(r.content)).join('\n')}</pre>`;
  } else if (bulk.skipped) {
    body = `<span class="meta">${esc(bulk.skipReason || '重复，已跳过')}</span>`;
  } else if (bulk.content) {
    body = `<pre class="memory-content">${esc(bulk.content)}</pre>`;
  }
  return { html: `<div class="memory-result"><span class="label">${label}</span><span class="meta">${bulk.itemCount != null ? `${bulk.itemCount} 条` : ''}</span>${body}</div>` };
}














































