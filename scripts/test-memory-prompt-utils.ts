/**
 * 记忆面板分块工具测试：splitPromptBlocks / joinPromptBlocks / extractBlockTitle / messageContentText
 * 验证：一级标题聚合分块（引言/子标题/无标题散段）、可逆性、无标题回退、短段合并、
 * 编辑场景（删除/重排）、边界、消息文本提取。
 */
import { splitPromptBlocks, joinPromptBlocks, extractBlockTitle, messageContentText } from '../electron/renderer/src/utils/memory-prompt-utils';

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

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);

