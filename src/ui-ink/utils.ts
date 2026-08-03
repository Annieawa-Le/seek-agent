/** 移除 ANSI 转义序列，返回纯文本 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1b\[[\d;<=>?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x1b]*(?:\x1b\\|\x07)/g, '');
}

/** 获取单个字符在终端中的显示宽度（全角=2，半角=1，控制字符=0） */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code < 32) return 0;
  // CJK 范围
  if ((code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x2E80 && code <= 0x2EFF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF01 && code <= 0xFF60)) return 2;
  // 几何图形（◀▶◆等）在终端中通常渲染为 1 列，排除 emoji 误判
  if (code >= 0x25A0 && code <= 0x25FF) return 1;
  // Emoji
  if (code > 0xFFFF || /\p{Extended_Pictographic}/u.test(ch)) return 2;
  return 1;
}

/** 计算字符串在终端中的实际显示宽度 */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += charWidth(ch);
  }
  return w;
}

/** 格式化时间（HH:mm:ss） */
export function formatTime(ms?: number): string {
  const d = ms ? new Date(ms) : new Date();
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 将文本按视觉宽度换行（纯文本，无 ANSI），返回多行 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return text.split('\n');
  const result: string[] = [];
  for (const seg of text.split('\n')) {
    if (seg.length === 0) { result.push(''); continue; }
    let line = '';
    let len = 0;
    for (const ch of seg) {
      const w = charWidth(ch);
      if (len > 0 && len + w > maxWidth) {
        result.push(line);
        line = '';
        len = 0;
      }
      line += ch;
      len += w;
    }
    result.push(line);
  }
  return result;
}

/** 截断文本到最大宽度，超长加省略号 */
export function truncate(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch);
    if (w + cw + 1 > maxWidth) break; // 留 1 列给省略号
    out += ch;
    w += cw;
  }
  return out + '…';
}
