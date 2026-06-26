/** 简单的 Markdown → HTML 渲染 */
export function renderMarkdown(text: string): string {
  if (!text) return '';

  let html = escapeHtml(text);

  // 代码块
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre${langAttr}><code>${code}</code></pre>`;
  });

  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 引用
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // 列表
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  html = html.replace(/^(\d+)\. (.+)$/gm, '<li value="$1">$2</li>');

  // 粗体 / 斜体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // 链接
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // 分割线
  html = html.replace(/^-{3,}$/gm, '<hr>');

  // 段落
  html = html.split('\n').filter(line => line.trim()).map(line => `<p>${line}</p>`).join('\n');

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
