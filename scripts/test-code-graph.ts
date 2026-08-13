/**
 * test-code-graph.ts — code-graph 8 工具功能测试
 * 使用 scripts/fixtures/code-graph-fixture 作为测试项目
 */
import path from 'path';
import { fileURLToPath } from 'url';
import {
  listSymbols,
  readSymbol,
  findReferences,
  traceCallers,
  traceCallees,
  traceChain,
  fileDeps,
  blastRadius,
} from '../src/tools/inner_skills/code-graph/scripts/ts-graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'code-graph-fixture');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

function contains(haystack: string, ...needles: string[]): boolean {
  return needles.every((n) => haystack.includes(n));
}

console.log('═══ code-graph 工具测试 ═══\n');

// ─── 1. list_symbols ─────────────────────────────────────────
console.log('▶ list_symbols');

{
  const { symbols } = await listSymbols(FIXTURE, path.join(FIXTURE, 'main.ts'));
  const names = symbols.map((s) => s.name);
  check('main.ts 含 run/processResult', contains(names.join(','), 'run', 'processResult'), names.join(','));
  check('main.ts 含 VERSION/Status/Level/Config', contains(names.join(','), 'VERSION', 'Status', 'Level', 'Config'));
  check('run 标记为导出', symbols.some((s) => s.name === 'run' && s.exported));
  check('internalOnly 未导出', symbols.some((s) => s.name === 'internalOnly' && !s.exported));
  check('run 有行号', symbols.find((s) => s.name === 'run')!.startLine > 0);
}

{
  const { symbols } = await listSymbols(FIXTURE, path.join(FIXTURE, 'models', 'user.ts'));
  const names = symbols.map((s) => s.name);
  check('user.ts 含 User 类与 greet 方法', contains(names.join(','), 'User', 'greet', 'secret'), names.join(','));
  check('greet 标记为 User 类方法', symbols.some((s) => s.name === 'greet' && s.container === 'User'));
}

// ─── 2. read_symbol ──────────────────────────────────────────
console.log('\n▶ read_symbol');

{
  const out = await readSymbol(FIXTURE, path.join(FIXTURE, 'main.ts'), 'run');
  check('run 定义含签名与代码体', contains(out, 'run', 'helper', 'processResult'), out.slice(0, 200));
  check('run 定义含位置行号', contains(out, '位置'));
}

{
  const out = await readSymbol(FIXTURE, path.join(FIXTURE, 'models', 'user.ts'), 'User.greet');
  check('User.greet 读取到方法体', contains(out, 'greet', 'hi'), out.slice(0, 200));
}

{
  const out = await readSymbol(FIXTURE, path.join(FIXTURE, 'main.ts'), 'VERSION');
  check('VERSION 常量可读', contains(out, 'VERSION', '1.0.0'), out.slice(0, 200));
}

// ─── 3. find_references ──────────────────────────────────────
console.log('\n▶ find_references');

{
  const { refs, total } = await findReferences(FIXTURE, 'helper');
  check('helper 有引用', total > 0, `total=${total}`);
  check('引用包含 main.ts 中的调用点', refs.some((r) => r.file.endsWith('main.ts')), JSON.stringify(refs.map((r) => r.file)));
}

{
  const { refs, total } = await findReferences(FIXTURE, 'User');
  check('User 有跨文件引用', total > 0, `total=${total}`);
  check('引用包含 main.ts', refs.some((r) => r.file.endsWith('main.ts')));
}

// ─── 4. trace_callers ────────────────────────────────────────
console.log('\n▶ trace_callers');

{
  const { callers, total } = await traceCallers(FIXTURE, path.join(FIXTURE, 'utils', 'helper.ts'), 'helper');
  check('helper 有调用方', total > 0, `total=${total}`);
  check('调用方是 main.ts 的 run', callers.some((c) => c.file.endsWith('main.ts') && c.callerName === 'run'), JSON.stringify(callers));
}

{
  const { callers, total } = await traceCallers(FIXTURE, path.join(FIXTURE, 'main.ts'), 'processResult');
  check('processResult 被 run 调用', total > 0 && callers.some((c) => c.callerName === 'run'), JSON.stringify(callers));
}

// ─── 5. trace_callees ────────────────────────────────────────
console.log('\n▶ trace_callees');

{
  const { callees, total } = await traceCallees(FIXTURE, path.join(FIXTURE, 'main.ts'), 'run');
  const names = callees.map((c) => c.name);
  check('run 调用 helper/processResult', contains(names.join(','), 'helper', 'processResult'), names.join(','));
  check('run 调用数 = 3', total >= 2, `total=${total}`);
}

{
  const { callees, total } = await traceCallees(FIXTURE, path.join(FIXTURE, 'main.ts'), 'processResult');
  check('processResult 无内部调用', total === 0, `total=${total}`);
}

// ─── 6. trace_chain ──────────────────────────────────────────
console.log('\n▶ trace_chain');

{
  const { chain, truncated } = await traceChain(FIXTURE, path.join(FIXTURE, 'main.ts'), 'run', 3);
  const names = chain.map((c) => c.name);
  check('调用链含 run 及其后代', contains(names.join(','), 'run'), names.join(','));
  check('链含 3+ 节点', chain.length >= 2, `chain=${chain.length}`);
  check('深度 3 不截断', !truncated);
}

{
  const { chain } = await traceChain(FIXTURE, path.join(FIXTURE, 'main.ts'), 'run', 1);
  check('深度 1 只有根', chain.length === 1, `chain=${chain.length}`);
}

// ─── 7. file_deps ────────────────────────────────────────────
console.log('\n▶ file_deps');

{
  const { deps } = await fileDeps(FIXTURE, path.join(FIXTURE, 'main.ts'));
  const targets = deps.map((d) => d.to);
  check('main.ts 依赖 helper 和 user', targets.some((t) => t.includes('helper')), targets.join(','));
  check('main.ts 依赖 user 模型', targets.some((t) => t.includes('user')), targets.join(','));
  check('依赖都有行号', deps.every((d) => d.line > 0));
}

{
  const { deps } = await fileDeps(FIXTURE, path.join(FIXTURE, 'utils', 'helper.ts'));
  check('helper.ts 无依赖', deps.length === 0, `deps=${deps.length}`);
}

// ─── 8. blast_radius ─────────────────────────────────────────
console.log('\n▶ blast_radius');

{
  const { hits, files, total } = await blastRadius(FIXTURE, path.join(FIXTURE, 'utils', 'helper.ts'));
  check('改 helper.ts 影响 main.ts', total > 0 && files.some((f) => f.endsWith('main.ts')), JSON.stringify(files));
  check('hits 是 import 类型', hits.some((h) => h.kind === 'import'));
}

{
  const { hits, total } = await blastRadius(FIXTURE, path.join(FIXTURE, 'models', 'user.ts'), 'User');
  check('改 User 符号影响 main.ts', total > 0 && hits.some((h) => h.file.endsWith('main.ts')), JSON.stringify(hits.slice(0, 3)));
}

// ─── 汇总 ────────────────────────────────────────────────────
console.log(`\n═══ 结果: ${passed} 通过, ${failed} 失败 ═══`);
if (failed > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
