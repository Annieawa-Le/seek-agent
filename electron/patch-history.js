/**
 * patch-history.js — .seek-agent/history/*.diff 的读取约定
 *
 * 文件结构：元信息 JSON 头 + 60 个 ─ 组成的分隔线 + unified diff 正文。
 * 主进程的 fs:listPatches 与测试脚本共用这里的解析，避免两处走样。
 */

/** 元信息与正文之间的分隔线（60 个 U+2500） */
export const PATCH_SEP = '─'.repeat(60);

/**
 * 从 .diff 原始文本中取出 unified diff 正文。
 *
 * ⚠️ 正文绝不能 trim()：每行都带 1 个字符的前缀（' ' 上下文 / '+' 新增 / '-' 删除），
 * 首行是上下文行，它的前缀恰好就是一个空格。trim() 会把这个空格连同两端换行一起
 * 吃掉，首行随即失去前缀 —— parseHunk 认不出它，整条记录被判为非法，内联差异
 * 于是永远渲染不出来。这里只剥离两端多余的换行，一个空格都不动。
 *
 * @param {string} raw .diff 文件全文
 * @returns {string | null} 正文；找不到分隔线时返回 null
 */
export function extractPatchBody(raw) {
  const sep = raw.indexOf(PATCH_SEP);
  if (sep === -1) return null;
  return raw.slice(sep + PATCH_SEP.length).replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
}

/**
 * 按字符数上限截断正文，且只在行边界下刀。
 *
 * 硬切（slice(0, max)）会切出一个没有前缀的半行，parseHunk 会因尾部残留内容
 * 把整条记录判为非法 —— 大 patch（如整文件写入）就这么无声无息地消失了。
 * 切在换行处虽然丢掉了尾部上下文，但前半段仍是合法的 unified diff。
 *
 * @param {string} body 正文
 * @param {number} max 字符上限
 * @returns {string} 截断后的正文
 */
export function truncatePatchBody(body, max) {
  if (body.length <= max) return body;
  const cut = body.lastIndexOf('\n', max - 1);
  // 整篇没有换行（单行超长）时无处下刀，只能硬切
  return cut === -1 ? body.slice(0, max) : body.slice(0, cut);
}

/**
 * 解析 .diff 头部的元信息。
 * @param {string} raw .diff 文件全文
 * @returns {object | null} meta 对象；结构不符或 JSON 损坏时返回 null
 */
export function parsePatchMeta(raw) {
  const sep = raw.indexOf(PATCH_SEP);
  if (sep === -1) return null;
  try {
    return JSON.parse(raw.slice(0, sep).trim()).meta ?? null;
  } catch {
    return null;
  }
}
