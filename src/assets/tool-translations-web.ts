/**
 * tool-translations-web.ts — WebUI 工具调用标签（HTML 版）
 *
 * 将工具调用标签渲染为 HTML，而非 TUI 的 ANSI 转义码。
 * 供 electron-bridge.ts 使用，直接输出给 Web 渲染进程。
 */

/**
 * ANSI → HTML 转换
 * 处理 friendlyToolCallLabel 输出的 ANSI 颜色码/链接序列
 *
 * 注意：OSC 8 超链接内容中可能嵌套 ANSI 颜色码（如 \x1b[94m\x1b[4m），
 * 因此需要先提取 URI 并保留内部内容，再让后续替换处理嵌套的颜色码。
 */
export function ansiToHtml(text: string): string {
  let html = text;

  // 1) OSC 8 超链接: \x1b]8;;URI\x1b\...内部内容(可能含ANSI码)...\x1b]8;;\x1b\
  //    提取 URI，内部内容保留原样（后续替换会处理嵌套的 ANSI 码）
  html = html.replace(
    /\x1b\]8;;([^\x1b]*)\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g,
    (_match: string, uri: string, inner: string) => {
      const escapedUri = uri.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      // 内部内容先不 escape——其中还有 ANSI 颜色码待转换
      return `<a href="${escapedUri}" style="color:#2563eb;text-decoration:underline">${inner}</a>`;
    },
  );

  // 2) 38;2;R;G;B — 自定义 RGB
  html = html.replace(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g, (_m: string, r: string, g: string, b: string) => {
    return `<span style="color:rgb(${r},${g},${b})">`;
  });
  // 3) 简单颜色码
  html = html
    .replace(/\x1b\[94m/g, '<span style="color:#2563eb">')
    .replace(/\x1b\[35m/g, '<span style="color:#a855f7">')
    .replace(/\x1b\[36m/g, '<span style="color:#06b6d4">')
    .replace(/\x1b\[90m/g, '<span style="color:#94a3b8">')
    .replace(/\x1b\[30m/g, '<span style="color:#6b7280">')
    .replace(/\x1b\[32m/g, '<span style="color:#16a34a">')
    .replace(/\x1b\[31m/g, '<span style="color:#dc2626">')
    .replace(/\x1b\[33m/g, '<span style="color:#ca8a04">')
    .replace(/\x1b\[1m/g, '<strong>')
    .replace(/\x1b\[2m/g, '<span style="opacity:0.7">')
    .replace(/\x1b\[4m/g, '<span style="text-decoration:underline">')
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/<\/strong><\/span>/g, '</strong>')
    .replace(/(<\/span>)+/g, '</span>');

  // 4) 兜底：擦掉任何剩余的控制序列
  html = html.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  return html;


}
