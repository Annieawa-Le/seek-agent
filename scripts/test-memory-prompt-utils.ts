/**
 * 记忆面板分块工具测试：splitPromptBlocks / joinPromptBlocks / extractBlockTitle / messageContentText / buildSubTree / applyNodeEdit
 * 验证：一级标题聚合分块（引言/子标题/无标题散段）、代码块围栏感知、可逆性、无标题回退、短段合并、
 * 编辑场景（删除/重排）、边界、子标题树层级与行号区间、段落级编辑、消息文本提取。
 */
import { splitPromptBlocks, joinPromptBlocks, extractBlockTitle, messageContentText, buildSubTree, applyNodeEdit } from '../electron/renderer/src/utils/memory-prompt-utils';

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('[1] 一级标题分块（MAIN.md 式：引言 + 多标题）');
{
  // 模拟真实 system：引言（无标题）→ # 个性 → # 通用原则（含 ## 子标题）→ 无标题散段（platform）→ # 工作流
  const sys = [
    '你是 deepseek，一个编程助手。',
    '# 个性',
    '作为一个编程助手，你拥有丰富的内心世界。',
    '# 通用原则',
    '你运用资深工程师的判断力。',
    '## 工程判断',
    '你选择保守的方式。',
    '> 当前工作目录：/tmp/demo',
    '# 工作流指南',
    '先理解后修改。',
  ].join('\n\n');
  const blocks = splitPromptBlocks(sys);
  assert('分块数 = 4（引言 + 3 标题）', blocks.length === 4, `实际 ${blocks.length}`);
  assert('引言块标题取摘要', blocks[0].title.includes('你是 deepseek'), blocks[0].title);
  assert('引言块内容不含 # 标题', !blocks[0].content.includes('# 个性'), blocks[0].content.slice(0, 40));
  assert('第 2 块标题 = 个性', blocks[1].title === '个性', blocks[1].title);
  assert('通用原则块含 ## 子标题与无标题散段', blocks[2].content.includes('## 工程判断') && blocks[2].content.includes('当前工作目录'), blocks[2].content.slice(0, 60));
  assert('第 3 块标题 = 通用原则', blocks[2].title === '通用原则', blocks[2].title);
  assert('第 4 块标题 = 工作流指南', blocks[3].title === '工作流指南', blocks[3].title);
}

console.log('[2] 可逆性：重组后与原 system 等价');
{
  const sys = [
    '第一部分内容\n第二行',
    '# 技能',
    '- a\n- b',
    '结尾（归入 # 技能 块）',
  ].join('\n\n');
  const blocks = splitPromptBlocks(sys);
  const joined = joinPromptBlocks(blocks);
  assert('重组 === 原文', joined === sys, `\n原文: ${JSON.stringify(sys)}\n重组: ${JSON.stringify(joined)}`);
}

console.log('[3] 无一级标题回退：按空行切分 + 短段合并');
{
  // 纯文本（无 # 标题）→ 回退路径
  const longA = 'A'.repeat(300);
  const longC = 'C'.repeat(300);
  const sys = `${longA}\n\n小尾巴\n\n${longC}`;
  const blocks = splitPromptBlocks(sys);
  assert('回退合并后 2 块', blocks.length === 2, `实际 ${blocks.length}`);
  assert('短段并入第一块（长块）', blocks[0].content.includes('小尾巴'), blocks[0].content.slice(0, 30));
  assert('回退重组仍可还原', joinPromptBlocks(blocks) === sys);
  // 连续短段不应无限制并成一块
  const shortOnly = splitPromptBlocks('A 段内容\n\nB 段内容\n\nC 段内容');
  assert('连续短段各自独立成块（3 块）', shortOnly.length === 3, `实际 ${shortOnly.length}`);
  // 单行无标题
  assert('无空行单段', splitPromptBlocks('只有一段\n两行').length === 1);
}

console.log('[4] 编辑场景：删除选中 + 拖动重排');
{
  const sys = ['# 块A', 'A'.repeat(60) + ' 内容', '# 块B', 'B'.repeat(60) + ' 内容', '# 块C', 'C'.repeat(60) + ' 内容'].join('\n\n');
  let blocks = splitPromptBlocks(sys);
  assert('初始 3 块', blocks.length === 3, `实际 ${blocks.length}`);
  // 删除第 2 块
  blocks = blocks.filter(b => b.title !== '块B');
  assert('删除后 2 块', blocks.length === 2);
  const joinedDel = joinPromptBlocks(blocks);
  assert('删除后重组不含 B', !joinedDel.includes('块B') && !joinedDel.includes('B'.repeat(60)), joinedDel.slice(0, 60));
  // 拖动重排（C 移到最前）
  const [c] = blocks.splice(1, 1);
  blocks.unshift(c);
  const joinedMove = joinPromptBlocks(blocks);
  assert('重排后 C 在最前', joinedMove.startsWith('# 块C'), joinedMove.slice(0, 20));
}

console.log('[5] 空输入与边界');
{
  assert('空 system 分块为空', splitPromptBlocks('').length === 0);
  assert('空白 system 分块为空', splitPromptBlocks('   \n\n  ').length === 0);
  assert('join 空数组为空串', joinPromptBlocks([]) === '');
  const multi = 'a\n\n\n\nb'; // 多个连续空行，无标题 → 回退
  assert('多空行规范化后可还原语义', joinPromptBlocks(splitPromptBlocks(multi)) === 'a\n\nb', JSON.stringify(joinPromptBlocks(splitPromptBlocks(multi))));
  // 只有标题无内容
  const headOnly = splitPromptBlocks('# 只有标题\n\n# 另一个');
  assert('标题块保留（无内容也成块）', headOnly.length === 2, `实际 ${headOnly.length}`);
}

console.log('[6] 消息文本提取');
{
  assert('字符串直通', messageContentText({ content: 'hello' }) === 'hello');
  assert('parts 数组取 text', messageContentText({ content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', toolName: 'read_file' }] }) === 'hi\n[工具调用 read_file]');
  assert('null 内容为空', messageContentText({ content: null }) === '');
  assert('undefined 内容为空', messageContentText({ content: undefined }) === '');
  assert('对象内容 JSON 化', messageContentText({ content: { a: 1 } }) === '{"a":1}');
}

console.log('[7] 代码块围栏感知：围栏内 # 行不当作标题');
{
  const sys = [
    '# 真实标题',
    '正文',
    '```bash',
    '# 这是代码块注释',
    'echo hi',
    '```',
    '# 另一个标题',
    '结尾',
  ].join('\n\n');
  const blocks = splitPromptBlocks(sys);
  assert('代码块内 # 注释不切块（共 2 块）', blocks.length === 2, `实际 ${blocks.length}`);
  assert('第 1 块含代码块注释内容', blocks[0].content.includes('# 这是代码块注释'));
  assert('第 2 块标题 = 另一个标题', blocks[1].title === '另一个标题');
  // 围栏开合影响重组？重组必须仍等价
  assert('围栏场景重组可还原', joinPromptBlocks(blocks) === sys);
  // 只有代码块注释没有真实标题 → 回退段落切分
  const onlyFence = splitPromptBlocks('```\n# not a heading\n```');
  assert('仅围栏内 # 时回退（不切成标题块）', onlyFence.length === 1, `实际 ${onlyFence.length}`);
  // 未闭合围栏：其后 # 行不当作标题（保守处理）
  const unclosed = splitPromptBlocks('# 开头标题\n```\n# 围栏内\n');
  assert('未闭合围栏后 # 不切块（共 1 块）', unclosed.length === 1, `实际 ${unclosed.length}`);
}

console.log('[8] buildSubTree：标题树层级 + 代码块感知 + preamble');
{
  const content = [
    '块引言',
    '## 二级甲',
    '内容甲',
    '### 三级甲1',
    '内容甲1',
    '### 三级甲2',
    '内容甲2',
    '## 二级乙',
    '内容乙',
    '```ts',
    '# not heading',
    '```',
  ].join('\n');
  const tree = buildSubTree(content);
  assert('preamble = 块引言', tree.preamble === '块引言', JSON.stringify(tree.preamble));
  assert('2 个二级根节点', tree.nodes.length === 2, `实际 ${tree.nodes.length}`);
  const a = tree.nodes[0];
  assert('二级甲标题与级别', a.title === '二级甲' && a.level === 2);
  assert('二级甲直属内容含内容甲', a.lines.join('\n').includes('内容甲'));
  assert('二级甲有 2 个三级子节点', a.children.length === 2, `实际 ${a.children.length}`);
  assert('三级甲1 内容', a.children[0].title === '三级甲1' && a.children[0].lines.join('\n').includes('内容甲1'));
  const b = tree.nodes[1];
  assert('二级乙标题', b.title === '二级乙');
  assert('代码块内 # 注释归入内容行', b.lines.join('\n').includes('# not heading'));
  // 三级再下钻到四级
  const deep = buildSubTree('## L2\n### L3\n#### L4\n内容L4\n## L2b');
  assert('四级节点挂在三级下', deep.nodes[0].children[0].children[0].title === 'L4');
  assert('回到同级 ## 断开旧链', deep.nodes.length === 2 && deep.nodes[1].title === 'L2b');
  // 无子标题
  const flat = buildSubTree('只有一段\n没有标题');
  assert('无子标题 nodes 为空', flat.nodes.length === 0 && flat.preamble.includes('只有一段'));
  // 纯函数：不修改入参
  const copy = content;
  buildSubTree(content);
  assert('buildSubTree 不改 content', content === copy);
}

console.log('[9] extractBlockTitle 跳过围栏行');
{
  const t = extractBlockTitle('```ts\n# comment\n```\n真实标题内容');
  assert('围栏行被跳过', !t.includes('```'), t);
  assert('取到围栏后的行', t.includes('真实标题'), t);
  const t2 = extractBlockTitle('## 二级标题\n正文');
  assert('二级标题提取', t2 === '二级标题', t2);
}

console.log('[10] 行号区间：节点/preamble 记录正文行范围');
{
  const content = ['前言1', '前言2', '## 二级甲', '甲1', '甲2', '### 三级甲1', '甲1深', '## 二级乙', '乙1'].join('\n');
  const tree = buildSubTree(content);
  // 前言 = 行 1-2
  assert('preamble 区间 1..2', tree.preambleStart === 1 && tree.preambleEnd === 2, `${tree.preambleStart}..${tree.preambleEnd}`);
  const a = tree.nodes[0];
  const b = tree.nodes[1];
  // ## 二级甲 在行 3，正文行 4-5（甲1、甲2），### 三级甲1 在行 6
  assert('二级甲正文区间 4..5', a.linesStart === 4 && a.linesEnd === 5, `${a.linesStart}..${a.linesEnd}`);
  // ### 三级甲1 在行 6，正文行 7
  const c = a.children[0];
  assert('三级甲1正文区间 7..7', c.linesStart === 7 && c.linesEnd === 7, `${c.linesStart}..${c.linesEnd}`);
  // ## 二级乙 在行 8，正文行 9
  assert('二级乙正文区间 9..9', b.linesStart === 9 && b.linesEnd === 9, `${b.linesStart}..${b.linesEnd}`);
  // 空正文节点
  const empty = buildSubTree('## 空节点\n## 下一个');
  assert('空正文区间为空（start = end+1）', empty.nodes[0].linesStart === 2 && empty.nodes[0].linesEnd === 1);
}

console.log('[11] applyNodeEdit：段落级区间替换');
{
  const content = ['前言1', '## 二级甲', '甲1', '甲2', '## 二级乙', '乙1'].join('\n');
  const tree = buildSubTree(content);
  const a = tree.nodes[0];
  const b = tree.nodes[1];
  // 替换二级甲正文（行 3-4 → 新两行）
  const edited1 = applyNodeEdit(content, a.linesStart, a.linesEnd, '甲X\n甲Y');
  assert('替换后标题行保留', edited1.includes('## 二级甲'), edited1);
  assert('新内容生效', edited1.includes('甲X\n甲Y'));
  assert('未触及行保留', edited1.startsWith('前言1') && edited1.includes('## 二级乙\n乙1'), edited1);
  // 再次解析验证区间仍正确
  const tree2 = buildSubTree(edited1);
  assert('编辑后重新解析：二级甲正文为甲X/甲Y', tree2.nodes[0].lines.join('\n') === '甲X\n甲Y', tree2.nodes[0].lines.join('\n'));
  // 删除一段（空文本）
  const edited2 = applyNodeEdit(content, b.linesStart, b.linesEnd, '');
  assert('删除后二级乙无正文', edited2 === '前言1\n## 二级甲\n甲1\n甲2\n## 二级乙', edited2);
  // 空区间插入（正文后追加）
  const edited3 = applyNodeEdit(content, b.linesStart, b.linesEnd, '追加行');
  assert('空区间插入', edited3.endsWith('## 二级乙\n追加行'), edited3);
  // 替换前言
  const edited4 = applyNodeEdit(content, tree.preambleStart, tree.preambleEnd, '新前言');
  assert('替换前言', edited4.startsWith('新前言\n## 二级甲'), edited4);
  // 空编辑无变化（start=2, end=1 为空区间，对应空正文节点）
  assert('空区间+空文本原样返回', applyNodeEdit(content, 2, 1, '') === content);
}

console.log('[12] 段落编辑与重组协同：编辑后 join 仍还原语义');
{
  const sys = ['# 块A', '引言', '## 子1', '内容1', '# 块B', '内容B'].join('\n\n');
  let blocks = splitPromptBlocks(sys);
  const tree = buildSubTree(blocks[0].content);
  // 编辑 块A 的子1 正文
  const edited = applyNodeEdit(blocks[0].content, tree.nodes[0].linesStart, tree.nodes[0].linesEnd, '内容X');
  blocks = blocks.map(b => b.title === '块A' ? { ...b, content: edited } : b);
  const joined = joinPromptBlocks(blocks);
  assert('段落编辑后重组含新内容', joined.includes('内容X'));
  assert('段落编辑后重组保留块B', joined.includes('# 块B\n\n内容B'));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);








