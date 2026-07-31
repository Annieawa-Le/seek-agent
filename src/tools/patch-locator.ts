/**
 * patch-locator.ts — 基于上下文行（pretext/endtext）的精确定位
 *
 * 在用户锚点附近的窗口内精确匹配 pretext 和 endtext 行序列，
 * 返回操作边界。不做行号偏移推测，只做精确匹配。
 */

/**
 * contextLocate — 基于上下文行（pretext/endtext）的精准定位
 *
 * 在 [anchor-radius, anchor+radius] 范围内精确匹配 pretext 和 endtext 行序列，
 * 返回操作边界。不依赖行号偏移推测，只做精确匹配。
 *
 * 返回语义：
 *   pretextEndLine  — pretext 末行之后的第一行（1-based），作为操作的起始行
 *   endtextStartLine — endtext 的首行（1-based），作为操作的结束行（不含）
 *   各工具根据自身语义使用这两个值
 */
export function contextLocate(
  fileLines: string[],
  pretext: string[] | undefined,
  endtext: string[] | undefined,
  anchorStart: number,
  anchorEnd: number,
  radius: number = 20,
): { matched: boolean; pretextEndLine: number; endtextStartLine: number; message: string } {
  const totalLines = fileLines.length;
  const searchStart = Math.max(1, anchorStart - radius);
  const searchEnd = Math.min(totalLines, anchorEnd + radius);

  // 未提供上下文时返回无匹配
  if ((!pretext || pretext.length === 0) && (!endtext || endtext.length === 0)) {
    return { matched: false, pretextEndLine: 0, endtextStartLine: 0, message: '未提供上下文行，使用原始行号' };
  }

  let pretextEnd = 0;  // 1-based，pretext 匹配后第一行
  let endtextStart = 0; // 1-based，endtext 匹配的首行
  const msgs: string[] = [];

  // 1. 搜索 pretext
  if (pretext && pretext.length > 0) {
    const pLen = pretext.length;
    // 滑动窗口匹配（精确逐行）
    for (let i = searchStart - 1; i + pLen - 1 < searchEnd; i++) {
      let match = true;
      for (let j = 0; j < pLen; j++) {
        if (fileLines[i + j] !== pretext[j]) { match = false; break; }
      }
      if (match) {
        pretextEnd = i + pLen; // pretext 末行的下一行
        msgs.push('pretext 匹配于行 ' + (i + 1) + '-' + (i + pLen));
        break;
      }
    }
    if (pretextEnd === 0) msgs.push('pretext 未匹配');
  }

  // 2. 搜索 endtext（从 pretext 匹配位置之后或搜索起点开始）
  if (endtext && endtext.length > 0) {
    const eLen = endtext.length;
    const startFrom = pretextEnd > 0 ? pretextEnd - 1 : searchStart - 1;
    for (let i = startFrom; i + eLen - 1 < searchEnd; i++) {
      let match = true;
      for (let j = 0; j < eLen; j++) {
        if (fileLines[i + j] !== endtext[j]) { match = false; break; }
      }
      if (match) {
        endtextStart = i + 1; // endtext 的首行
        msgs.push('endtext 匹配于行 ' + (i + 1) + '-' + (i + eLen));
        break;
      }
    }
    if (endtextStart === 0) msgs.push('endtext 未匹配');
  }

  const matched = (pretext && pretext.length > 0 ? pretextEnd > 0 : true)
    && (endtext && endtext.length > 0 ? endtextStart > 0 : true);

  return { matched, pretextEndLine: pretextEnd, endtextStartLine: endtextStart, message: msgs.join('；') || '未匹配' };
}

