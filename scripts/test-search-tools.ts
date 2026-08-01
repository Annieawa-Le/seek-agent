/**
 * 搜索工具回归测试
 * 运行：pnpm tsx scripts/test-search-tools.ts
 *
 * 覆盖：
 *  1. 正则搜索不再永远空结果（修复 assert.match 误用）
 *  2. 支持按相对路径片段匹配（旧版只匹配 basename）
 *  3. 普通关键词大小写不敏感
 *  4. 递归搜索跳过 node_modules/.git 等依赖目录
 *  5. searchSubFile 目录条目带 isDir 标记（不再用 [文件夹] 前缀污染匹配）
 *  6. maxResults / truncated 语义正确
 *  7. searchContent 支持目录递归搜索（多文件带 filePath）
 *  8. searchContent 单文件保持原格式
 *  9. searchContent 截断标记
 * 10. searchDirectory 跳过依赖目录
 */
import { searchAllFile, searchSubFile, searchDirectory, searchContent } from '../src/tools/search-files.js';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? ' -- ' + detail : '')); }
}

function parseSearch(text: string): Array<{ name: string; path: string; isDir?: boolean }> {
  try { return JSON.parse(text); } catch { return []; }
}

async function main() {
  // ── 1. 正则搜索：在 src 下搜 .ts 文件（旧代码 assert.match 永远空） ──
  {
    const r = await searchAllFile.execute({ filePath: 'src', fileName: '.*\\.ts$', useRegex: true });
    const list = parseSearch(String(r));
    check('1a 正则搜索返回非空', list.length > 0, String(r).slice(0, 120));
    check('1b 结果都是 .ts 文件', list.every(f => f.name.endsWith('.ts')), JSON.stringify(list.slice(0, 3)));
    const bulk = (r as any).rawBulk;
    check('1c totalCount = 匹配总数', bulk.totalCount >= list.length, `total=${bulk.totalCount}, shown=${list.length}`);
  }

  // ── 2. 按相对路径片段匹配 ──
  {
    const r = await searchAllFile.execute({ filePath: 'src', fileName: 'tools/search', useRegex: false });
    const list = parseSearch(String(r));
    check('2 路径片段命中 search-files.ts', list.some(f => f.path.replace(/\\/g, '/').includes('src/tools/search-files.ts')),
      JSON.stringify(list.map(f => f.path)));
  }

  // ── 3. 大小写不敏感 ──
  {
    const r = await searchAllFile.execute({ filePath: 'src', fileName: 'SEARCH-FILES', useRegex: false });
    const list = parseSearch(String(r));
    check('3 大小写不敏感命中', list.some(f => f.name.toLowerCase() === 'search-files.ts'), JSON.stringify(list.map(f => f.name)));
  }

  // ── 4. 跳过 node_modules ──
  {
    const r = await searchAllFile.execute({ filePath: '.', fileName: '.*', useRegex: true });
    const list = parseSearch(String(r));
    check('4 结果不含 node_modules 路径', !list.some(f => f.path.includes('node_modules')), JSON.stringify(list.slice(0, 5).map(f => f.path)));
  }

  // ── 5. searchSubFile 目录 isDir 标记 ──
  {
    const r = await searchSubFile.execute({ filePath: 'src', fileName: 'tools', useRegex: false });
    const list = parseSearch(String(r));
    const dir = list.find(f => f.name === 'tools');
    check('5 目录条目 isDir=true', dir !== undefined && dir.isDir === true, JSON.stringify(dir));
    check('5b 目录名不含 [文件夹] 前缀', dir !== undefined && !dir.name.startsWith('[文件夹]'));
  }

  // ── 6. maxResults / truncated ──
  {
    const r = await searchAllFile.execute({ filePath: 'src', fileName: '.ts', useRegex: false, maxResults: 3 });
    const list = parseSearch(String(r));
    const bulk = (r as any).rawBulk;
    check('6a maxResults=3 只返回 3 条', list.length === 3, String(list.length));
    check('6b truncated=true', bulk.truncated === true, JSON.stringify(bulk));
    check('6c totalCount 大于返回数', bulk.totalCount > 3, `total=${bulk.totalCount}`);
  }

  // ── 7. searchContent 目录递归搜索 ──
  {
    const r = await searchContent.execute({ filePath: 'src/tools', content: 'resolvePath', useRegex: false });
    const text = String(r);
    const bulk = (r as any).rawBulk;
    check('7a 目录搜索返回匹配', bulk.totalCount > 0, text.slice(0, 200));
    check('7b 匹配带 filePath', bulk.matches.every((m: any) => typeof m.filePath === 'string' && m.filePath.length > 0));
    check('7c 文本含 文件路径:行号 格式', /\.ts:\d+:/.test(text), text.split('\n')[1]);
  }

  // ── 8. searchContent 单文件保持原格式 ──
  {
    const r = await searchContent.execute({ filePath: 'src/tools/search-files.ts', content: 'compilePattern', useRegex: false });
    const text = String(r);
    check('8a 单文件命中', text.includes('compilePattern'));
    check('8b 单文件行号格式', /^\d+: /.test(text.split('\n')[1] ?? ''), text.split('\n')[1]);
    const bulk = (r as any).rawBulk;
    check('8c 单文件 matches 无 filePath', bulk.matches.every((m: any) => m.filePath === undefined));
  }

  // ── 9. searchContent 截断 ──
  {
    const r = await searchContent.execute({ filePath: 'src/tools', content: 'const', useRegex: false, maxResults: 5 });
    const bulk = (r as any).rawBulk;
    check('9a maxResults=5 返回 5 行', bulk.totalCount === 5, `total=${bulk.totalCount}`);
    check('9b truncated=true', bulk.truncated === true);
  }

  // ── 10. searchDirectory 跳过依赖目录 ──
  {
    const r = await searchDirectory.execute({ filePath: '.' });
    const list = parseSearch(String(r));
    check('10 目录结果不含 node_modules/.git', !list.some(f => f.name === 'node_modules' || f.name === '.git'),
      JSON.stringify(list.map(f => f.name).slice(0, 10)));
  }

  // ── 11. searchContent 大小写不敏感 ──
  {
    const r = await searchContent.execute({ filePath: 'src/tools/search-files.ts', content: 'COMPILEPATTERN', useRegex: false });
    check('11 内容搜索大小写不敏感', String(r).includes('compilePattern'));
  }

  // ── 12. searchContent 根目录搜索不崩溃 ──
  // ── 12. 不存在关键词不崩溃 + 根目录轻量搜索（跳过 sessions/release） ──
  {
    const r1 = await searchContent.execute({ filePath: 'src', content: '本关键词绝对不存在于源码xyz', useRegex: false });
    const b1 = (r1 as any).rawBulk;
    check('12a 无匹配返回 0 不崩溃', b1.totalCount === 0 && b1.error === undefined, JSON.stringify(b1));
    const r2 = await searchContent.execute({ filePath: '.', content: 'export const', useRegex: false, maxResults: 10 });
    const b2 = (r2 as any).rawBulk;
    check('12b 根目录搜索快速返回（跳过 sessions）', b2.totalCount > 0 && b2.totalCount <= 10, `total=${b2.totalCount}`);
  }

  console.log('\n==============================');
  console.log('PASS ' + pass + ' / ' + (pass + fail));
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });

