// 审计：统计每款皮肤 CSS 实际依赖的 DSH DOM 钩子（data-* / class 子串 / id）
// 用途：跟 escape-layer 的打标表比对，找出「规则整体落空」的缺口。
import fs from 'fs';
import path from 'path';

const dir = path.resolve(process.argv[2] || 'themes');
const reAttr = /\[data-[a-zA-Z0-9_-]+(?:\s*[~|^$*]?=\s*['"]?[^\]'"]*['"]?)?\]/g;
const reClass = /\[class[*^$~|]?=\s*["']?[^\]"']+["']?\]/g;
const reId = /\[id=['"]?[^\]'"]+['"]?\]/g;

const out = [];
for (const d of fs.readdirSync(dir)) {
  const p = path.join(dir, d, 'skin.css');
  if (!fs.existsSync(p)) continue;
  const css = fs.readFileSync(p, 'utf8');
  const attrs = {}, cls = {}, ids = {};
  for (const m of css.matchAll(reAttr)) { const k = m[0].replace(/\s+/g, '').toLowerCase(); attrs[k] = (attrs[k] || 0) + 1; }
  for (const m of css.matchAll(reClass)) { const k = m[0].replace(/\s+/g, '').toLowerCase(); cls[k] = (cls[k] || 0) + 1; }
  for (const m of css.matchAll(reId)) { const k = m[0].replace(/\s+/g, '').toLowerCase(); ids[k] = (ids[k] || 0) + 1; }
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map((e) => `${e[0]}(${e[1]})`).join(' ');
  out.push(`=== ${d} === css ${css.length} chars`);
  out.push(`  data-* [${Object.keys(attrs).length}]: ${fmt(attrs)}`);
  out.push(`  class*= [${Object.keys(cls).length}]: ${fmt(cls)}`);
  out.push(`  id= [${Object.keys(ids).length}]: ${fmt(ids)}`);
}
console.log(out.join('\n'));
