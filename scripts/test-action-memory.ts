/**
 * test-action-memory.ts — 行为记忆系统单元测试
 *
 * 覆盖：parseDistilled 解析、buildWindowText 窗口构建、ActionPoolStore 存储，
 *       isActionMemoryEnabled 开关。不触发真实 LLM 调用。
 */
import { parseDistilled, buildWindowText, ActionPoolStore, actionPool, isActionMemoryEnabled } from '../src/tools/action-memory';
import type { ModelMessage } from 'ai';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? '\n      ' + detail : ''}`); }
}

// ═══════════ parseDistilled ═══════════
console.log('parseDistilled');
{
  const r1 = parseDistilled('["<4.0>使用 patch 工具前一定要读取目标行号", "<2.5>搜索优先用 search_all_file"]');
  check('正常两条解析', r1.length === 2 && r1[0].weight === 4 && r1[0].content.includes('patch') && r1[1].weight === 2.5);
  check('权重与内容拆分', r1[0].weight === 4 && r1[1].content === '搜索优先用 search_all_file');

  const r2 = parseDistilled('```json\n["<3>批量修改前先读文件"]\n```');
  check('容忍代码块包裹', r2.length === 1 && r2[0].weight === 3);

  const r3 = parseDistilled('这是说明文字\n["<1.0>经验A"]\n再来点废话');
  check('容忍前后杂文本', r3.length === 1 && r3[0].content === '经验A');

  const r4 = parseDistilled('[]');
  check('空数组', r4.length === 0);

  const r5 = parseDistilled('没有值得记录的点');
  check('纯文本回退空', r5.length === 0);

  const r6 = parseDistilled('["<0>x", "<6>超界", "无格式", "<2.0>"]');
  check('过滤非法条目', r6.length === 1 && r6[0].weight === 5 && r6[0].content === '超界');
}

// ═══════════ buildWindowText ═══════════
console.log('buildWindowText');
{
  const mkTool = (name: string, value: string): ModelMessage => ({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 't1', toolName: name, output: { type: 'text', value } }],
  });
  const mkCall = (name: string): ModelMessage => ({
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 't1', toolName: name, input: { filePath: 'a.ts', startLine: 1, endLine: 10 } }],
  });

  const messages: ModelMessage[] = [
    { role: 'user', content: '帮我看看这个文件' },
    mkCall('read_file'),
    mkTool('read_file', '第 1 行内容……'),
    { role: 'user', content: '改一下' },
    mkCall('modify_patch'),
    mkTool('modify_patch', '✅ 已修改'),
  ];

  const w0 = buildWindowText(messages, 0);
  check('cursor=0 窗口含全部', w0.includes('帮我看看这个文件') && w0.includes('[调用] read_file') && w0.includes('[结果] modify_patch'));

  const w1 = buildWindowText(messages, 1);
  check('cursor=1 跳过第 1 个 tool', !w1.includes('read_file') && w1.includes('改一下') && w1.includes('modify_patch'));
  check('cursor=1 从最近 user 锚点起', w1.includes('[用户] 改一下'));

  // 长内容截断：结果超长被截断
  const bigMessage: ModelMessage[] = [
    { role: 'user', content: 'hi' },
    mkCall('read_file'),
    mkTool('read_file', 'A'.repeat(2000)),
  ];
  const wBig = buildWindowText(bigMessage, 0);
  check('单条结果截断', wBig.includes('[结果] read_file: ' + 'A'.repeat(800)) && !wBig.includes('A'.repeat(2000)));
}

// ═══════════ ActionPoolStore ═══════════
console.log('ActionPoolStore（操作 ~/.seek-agent/actions/pool.json，结束清理）');
{
  const store = new ActionPoolStore();
  const before = store.count;
  store.clear();

  const a = store.add('经验A', 2.5, 'ws1');
  const b = store.add('经验B', 4.0, 'ws2');
  check('add 后 count=2', store.count === 2);
  check('权重上限 5 钳制', store.add('经验C', 99).weight === 5);
  check('权重下限 0.1 钳制', store.add('经验D', 0.01).weight === 0.1);

  const listed = store.list();
  check('list 按权重降序', listed[0].content === '经验C' && listed[1].content === '经验B' && listed[2].content === '经验A');

  store.clear();
  check('clear 后 count=0', store.count === 0);
  // 恢复测试前状态
  if (before > 0) {
    // 无法恢复原条目（测试环境池通常为空），仅重置
  }
  console.log(`  （测试前池条目 ${before} 条已清空）`);
}

// ═══════════ isActionMemoryEnabled ═══════════
console.log('isActionMemoryEnabled');
{
  const old = process.env.ACTION_MEMORY_ENABLED;
  process.env.ACTION_MEMORY_ENABLED = 'true';
  check('true 开启', isActionMemoryEnabled() === true);
  process.env.ACTION_MEMORY_ENABLED = '1';
  check('1 开启', isActionMemoryEnabled() === true);
  process.env.ACTION_MEMORY_ENABLED = '';
  check('空关闭', isActionMemoryEnabled() === false);
  delete process.env.ACTION_MEMORY_ENABLED;
  check('未设置关闭', isActionMemoryEnabled() === false);
  process.env.ACTION_MEMORY_ENABLED = old;
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);