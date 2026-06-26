/** 简单的 Markdown → HTML 渲染 */
export function renderMarkdown(text: string): string {
  if (!text) return '';

  let html = escapeHtml(text);

  // ── 1. 代码块：提前提取并保护，避免内部内容被后续规则误伤 ──
  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    const block = `<pre${langAttr}><code>${code}</code></pre>`;
    codeBlocks.push(block);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // ── 2. 行内格式（在表格解析前处理，使表格内也支持粗体/斜体/代码/链接） ──
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // ── 3. 表格：提取并渲染为 <table>（必须在段落处理之前） ──
  const tables: string[] = [];
  html = html.replace(
    /^(\|.+?\|)[ \t]*\n(?:\|[-: |]+\|[ \t]*\n)?((?:\|.+?\|[ \t]*\n)*)/gm,
    (match) => {
      const lines = match.split('\n').filter((l: string) => l.trim());
      if (lines.length < 2) return match;

      // 判断第二行是否为分隔行
      const hasSeparator = /^[\| :-]+$/.test(lines[1]?.replace(/[ \t]/g, ''));
      const headerLine = lines[0];
      const bodyStart = hasSeparator ? 2 : 1;
      if (bodyStart >= lines.length) return match;

      const headers = headerLine.split('|').map((c: string) => c.trim()).filter((c: string) => c);
      if (headers.length === 0) return match;

      let tableHtml = '<table><thead><tr>';
      for (const h of headers) tableHtml += `<th>${h}</th>`;
      tableHtml += '</tr></thead><tbody>';

      for (let i = bodyStart; i < lines.length; i++) {
        const cells = lines[i].split('|').map((c: string) => c.trim()).filter((c: string) => c);
        if (cells.length === 0) continue;
        tableHtml += '<tr>';
        for (const c of cells) tableHtml += `<td>${c}</td>`;
        tableHtml += '</tr>';
      }

      tableHtml += '</tbody></table>';
      tables.push(tableHtml);
      return `\x00TABLE${tables.length - 1}\x00`;
    }
  );

  // ── 4. 行级格式 ──
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // 无序列表
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(?:^<li>.*<\/li>\n?)+/gm, (match) => `<ul>${match}</ul>`);
  // 有序列表
  html = html.replace(/^(\d+)\. (.+)$/gm, '<li value="$1">$2</li>');

  html = html.replace(/^-{3,}$/gm, '<hr>');

  // ── 5. 段落包裹 ──
  // 跳过：空行、占位符、已经是块级 HTML 的行
  const blockStart = /^<(table|thead|tbody|tr|th|td|ul|ol|li|pre|blockquote|h[1-6]|hr|p|div)/i;
  html = html.split('\n')
    .filter((line: string) => line.trim())
    .map((line: string) => {
      const trimmed = line.trim();
      if (blockStart.test(trimmed)) return line;
      if (trimmed.startsWith('\x00TABLE') || trimmed.startsWith('\x00CODEBLOCK')) return line;
      return `<p>${line}</p>`;
    })
    .join('\n');

  // ── 6. 恢复被保护的块 ──
  html = html.replace(/\x00TABLE(\d+)\x00/g, (_match, idx: string) => tables[parseInt(idx)] || '');
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx: string) => codeBlocks[parseInt(idx)] || '');

  return html;
}

/** ANSI 转 HTML */
export function renderAnsi(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  html = html
    .replace(/\x1b\[94m/g, '<span style="color:#3b82f6">')
    .replace(/\x1b\[35m/g, '<span style="color:#a855f7">')
    .replace(/\x1b\[32m/g, '<span style="color:#16a34a">')
    .replace(/\x1b\[31m/g, '<span style="color:#dc2626">')
    .replace(/\x1b\[33m/g, '<span style="color:#ca8a04">')
    .replace(/\x1b\[90m/g, '<span style="color:#64748b">')
    .replace(/\x1b\[36m/g, '<span style="color:#06b6d4">')
    .replace(/\x1b\[30m/g, '<span style="color:#374151">')
    .replace(/\x1b\[1m/g, '<span style="font-weight:600">')
    .replace(/\x1b\[2m/g, '<span style="opacity:0.7">')
    .replace(/\x1b\[4m/g, '<span style="text-decoration:underline">')
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');

  // 兜底擦除剩余控制序列
  html = html.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  html = html.replace(/(<\/span>)+/g, '</span>');
  return html;
}

export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

