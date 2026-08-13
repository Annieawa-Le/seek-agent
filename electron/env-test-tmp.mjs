// env-test-tmp.mjs — 临时验证 main.js 的 parseEnv / applyEnvUpdates 纯函数逻辑
// 用法：node env-test-tmp.mjs（只操作内存字符串，绝不触碰真实 .env）
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 从 main.js 文本中按大括号配对提取函数体（保证测试的就是后端实际代码） ──
const mainSrc = readFileSync(resolve(__dirname, 'main.js'), 'utf8');

function extractFn(name) {
  const marker = `export function ${name}(`;
  const start = mainSrc.indexOf(marker);
  if (start < 0) throw new Error(`未在 main.js 中找到 ${name}`);
  const brace = mainSrc.indexOf('{', start);
  let depth = 0;
  let end = brace;
  for (; end < mainSrc.length; end++) {
    const ch = mainSrc[end];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return mainSrc.slice(start, end + 1);
}

const fnCode = `${extractFn('parseEnv')}\n${extractFn('applyEnvUpdates')}\nreturn { parseEnv, applyEnvUpdates };`
  .replace(/export function/g, 'function');
const { parseEnv, applyEnvUpdates } = new Function(fnCode)();

let passed = 0;
function check(name, cond) {
  if (!cond) { console.error(`❌ FAIL: ${name}`); process.exitCode = 1; }
  else { passed++; console.log(`✅ PASS: ${name}`); }
}

// ── 1. parseEnv ──
const envText = [
  '# API keys',
  'OPENAI_KEY=sk-test-123',
  'EMPTY=',
  '',
  'MODEL=gpt-4',
  'no-equals-here',
  '_UNDERSCORE=ok',
  '123BAD=no',
].join('\n');

const items = parseEnv(envText);
check('parseEnv: 只返回有效项（4 条，注释/空行/无等号/非法 key 全部跳过）', items.length === 4);
check('parseEnv: key/value/行号正确', JSON.stringify(items[0]) === JSON.stringify({ key: 'OPENAI_KEY', value: 'sk-test-123', line: 2 }));
check("parseEnv: 空值保留为 '' 且行号正确", JSON.stringify(items[1]) === JSON.stringify({ key: 'EMPTY', value: '', line: 3 }));
check('parseEnv: 下划线开头合法 / 数字开头非法被跳过', items.some(i => i.key === '_UNDERSCORE' && i.value === 'ok' && i.line === 7) && !items.some(i => i.key === '123BAD'));

// ── 2. applyEnvUpdates ──
const orig = [
  '# OpenAI',
  'OPENAI_KEY = sk-old',
  'MODEL= gpt-3',
  '',
  '# 保持注释',
  'FOO=bar',
].join('\n');

const next = applyEnvUpdates(orig, [
  { key: 'OPENAI_KEY', value: 'sk-new' },
  { key: 'MODEL', value: 'gpt-4' },
  { key: 'FOO', value: '' },
  { key: 'NEW_KEY', value: 'v1' },
]);

const expected = [
  '# OpenAI',
  'OPENAI_KEY = sk-new',
  'MODEL= gpt-4',
  '',
  '# 保持注释',
  'FOO=',
  '',
  'NEW_KEY=v1',
].join('\n') + '\n';

check('applyEnvUpdates: 更新已有 KEY 并保留 = 前格式/缩进（整段文本一致）', next === expected);
check("applyEnvUpdates: 注释与空行原样保留、顺序不破坏", next.split('\n')[0] === '# OpenAI' && next.split('\n')[4] === '# 保持注释');
check("applyEnvUpdates: value 空 → 写 KEY= 保留该行", next.includes('\nFOO=\n'));
check("applyEnvUpdates: 文件不存在的 KEY 追加到末尾（前面补空行分隔）", next.endsWith('NEW_KEY=v1\n') && next.includes('\n\nNEW_KEY=v1'));
check('applyEnvUpdates: 空 updates / undefined → 返回原文', applyEnvUpdates(orig, []) === orig && applyEnvUpdates(orig, undefined) === orig);

console.log(`\n共 ${passed} 个断言全部 PASS ✔`);
if (process.exitCode) { console.error('存在失败断言'); process.exit(1); }