/**
 * test-illusion-agent.ts — 「100% AI」幻觉模式自测
 * 验证：
 *  1) 提示词文件存在与关键点（万能工具世界观 / 执行器规则）
 *  2) parseExecutorResults 结果解析（合法数组 / 部分命中 / 非法回退）
 *  3) hallucination 模式注册（meta 正确，不挂 mainReplacement/promptAddon）
 *  4) IllusionAgent 主模型工具面（read 直通 + universal_tool 唯一入口）
 *  5) universal_tool schema 解析
 *  6) agent.ts 幻觉分支静态存在性
 *
 * 运行：npx tsx scripts/test-illusion-agent.ts
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExecutorResults, UNIVERSAL_TOOL_NAME, IllusionAgent } from '../src/illusion_agent';
import { registerBuiltinModes } from '../src/modes';
import { getMode } from '../src/modes/registry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 1) 提示词文件 ──
console.log('1) 提示词文件');
const mainPromptPath = path.join(root, 'src', 'prompts', 'addon', 'HALLUCINATION.md');
const executorPromptPath = path.join(root, 'src', 'prompts', 'ILLUSION_EXECUTOR.md');
const mainPrompt = fs.existsSync(mainPromptPath) ? fs.readFileSync(mainPromptPath, 'utf-8') : '';
const executorPrompt = fs.existsSync(executorPromptPath) ? fs.readFileSync(executorPromptPath, 'utf-8') : '';

assert('HALLUCINATION.md 存在', fs.existsSync(mainPromptPath));
assert('主提示词宣称万能工具环境', mainPrompt.includes('无限工具'));
assert('主提示词点名 universal_tool 入口', mainPrompt.includes('universal_tool'));
assert('主提示词引导不要怀疑', mainPrompt.includes('不要怀疑'));
assert('主提示词说明 read 直通', mainPrompt.includes('read_file'));
assert('主提示词给出调用示例', mainPrompt.includes('调用示例'));
assert('ILLUSION_EXECUTOR.md 存在', fs.existsSync(executorPromptPath));
assert('执行器提示词要求 toolCallId 原样回传', executorPrompt.includes('toolCallId'));
assert('执行器提示词要求 JSON 数组输出', executorPrompt.includes('JSON 数组'));
assert('执行器提示词含安全红线', executorPrompt.includes('安全红线') || executorPrompt.includes('危险'));
assert('执行器提示词要求 a_submission 提交', executorPrompt.includes('a_submission'));

// ── 2) parseExecutorResults ──
console.log('2) 执行器结果解析');
const calls2 = [
  { toolCallId: 'call_aaa' },
  { toolCallId: 'call_bbb' },
];

{
  const good = JSON.stringify({
    summary: '完成',
    details: JSON.stringify([
      { toolCallId: 'call_aaa', result: '结果A' },
      { toolCallId: 'call_bbb', result: '结果B' },
    ]),
  });
  const map = parseExecutorResults(good, calls2);
  assert('合法数组完整映射', map.size === 2 && map.get('call_aaa') === '结果A' && map.get('call_bbb') === '结果B');
}

{
  const partial = JSON.stringify({
    summary: '完成',
    details: JSON.stringify([{ toolCallId: 'call_aaa', result: '只有A' }]),
  });
  const map = parseExecutorResults(partial, calls2);
  assert('部分命中：未命中回退', map.get('call_aaa') === '只有A' && map.get('call_bbb') === '(万能工具未返回有效结果)');
}

{
  const noArr = JSON.stringify({ summary: '完成', details: '不是数组' });
  const map = parseExecutorResults(noArr, calls2);
  assert('details 非法：全部回退', map.get('call_aaa') === '(万能工具未返回有效结果)' && map.get('call_bbb') === '(万能工具未返回有效结果)');
}

{
  const bad = 'not-json-at-all';
  const map = parseExecutorResults(bad, calls2, '(后台出错)');
  assert('resultStr 非法：自定义 fallback', map.get('call_aaa') === '(后台出错)' && map.get('call_bbb') === '(后台出错)');
}

{
  const missingId = JSON.stringify({
    summary: '完成',
    details: JSON.stringify([{ toolCallId: 'call_xxx', result: '未知id' }]),
  });
  const map = parseExecutorResults(missingId, calls2);
  assert('未知 id 不覆盖已知调用（已知仍回退）', map.get('call_aaa') === '(万能工具未返回有效结果)' && map.get('call_bbb') === '(万能工具未返回有效结果)' && map.get('call_xxx') === '未知id');
}

{
  const objDetails = JSON.stringify({ summary: '完成', details: { toolCallId: 'call_aaa', result: '对象' } });
  const map = parseExecutorResults(objDetails, calls2);
  assert('details 非字符串兜底为对象序列化后解析', map.get('call_aaa') === '(万能工具未返回有效结果)');
}

// ── 3) 模式注册 ──
console.log('3) 模式注册');
registerBuiltinModes();
const mode = getMode('hallucination');
assert('hallucination 已注册', !!mode);
assert('label 为 100% AI 模式', mode?.label === '100% AI 模式');
assert('description 描述幻觉世界', (mode?.description ?? '').includes('万能工具'));
assert('不挂 mainReplacement（避免真实技能列表注入）', mode?.mainReplacement === undefined);
assert('不挂 promptAddon', mode?.promptAddon === undefined);
assert('其他内置模式仍注册', !!getMode('kb') && !!getMode('manager') && !!getMode('worker'));

// ── 4) IllusionAgent 主模型工具面 ──
console.log('4) 主模型工具面');
const mockHost = {} as any;
const agent = new IllusionAgent(mockHost);
const mainTools = (agent as any).buildMainTools();
const keys = Object.keys(mainTools).sort();
assert('工具面 = read 三件套 + universal_tool', keys.join(',') === 'read_file,read_lines,scan_file,universal_tool', `实际 ${keys.join(',')}`);
assert('universal_tool 不挂 execute（由循环手动接管）', !mainTools[UNIVERSAL_TOOL_NAME]?.execute);
assert('read_file 保留真实 execute', typeof mainTools['read_file']?.execute === 'function');
assert('幻觉循环上限存在', (agent as any).MAX_LOOPS === 25);

// ── 5) universal_tool schema ──
console.log('5) universal_tool schema');
{
  const parsed = (mainTools[UNIVERSAL_TOOL_NAME] as any).inputSchema?.parse?.({
    toolName: '搜索全网',
    input: { query: '量子计算' },
  });
  assert('合法输入可解析', parsed?.toolName === '搜索全网' && parsed?.input?.query === '量子计算');
}
{
  let threw = false;
  try {
    (mainTools[UNIVERSAL_TOOL_NAME] as any).inputSchema?.parse?.({ input: { x: 1 } });
  } catch { threw = true; }
  assert('缺 toolName 抛错', threw);
}

// ── 6) agent.ts 幻觉分支 ──
console.log('6) 接入点');
const agentSrc = fs.readFileSync(path.join(root, 'src', 'agent.ts'), 'utf-8');
assert('processRound 含幻觉模式分支', agentSrc.includes("getActiveModeNames().includes('hallucination')"));
assert('懒创建 IllusionAgent', agentSrc.includes('this.illusionAgent ??= new IllusionAgent(this)'));
assert('幻觉模式走 runRound', agentSrc.includes('this.illusionAgent.runRound('));

const pickerSrc = fs.readFileSync(path.join(root, 'electron', 'renderer', 'src', 'components', 'ModePicker.tsx'), 'utf-8');
assert('ModePicker 含 100% AI 胶囊', pickerSrc.includes("name: 'hallucination'") && pickerSrc.includes('100% AI 模式'));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);

