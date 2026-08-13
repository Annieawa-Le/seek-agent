/**
 * test-code-graph-java-c.ts — code-graph tree-sitter 引擎测试（Java / C）
 * 使用 scripts/fixtures/code-graph-java-c-fixture 作为测试项目
 * 直接调用 ts-graph.ts 的 8 个导出函数（含语言分发逻辑）
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
const FIXTURE = path.join(__dirname, 'fixtures', 'code-graph-java-c-fixture');
const JAVA_ROOT = path.join(FIXTURE, 'demo', 'src');
const C_ROOT = path.join(FIXTURE, 'cproj');

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

console.log('═══ code-graph Java/C (tree-sitter) 工具测试 ═══\n');

// ─── 1. list_symbols ─────────────────────────────────────────
console.log('▶ list_symbols');

{
  const { symbols } = await listSymbols(JAVA_ROOT, path.join(JAVA_ROOT, 'com', 'example', 'Main.java'));
  const names = symbols.map((s) => s.name);
  check('Main.java 含 class Main / main 方法', contains(names.join(','), 'Main', 'main'), names.join(','));
  check('Main.java import 了 Order/Service', contains(names.join(','), 'Order', 'Service'), names.join(','));
  check('main 标记为 Main 类方法', symbols.some((s) => s.name === 'main' && s.container === 'Main'));
}

{
  const { symbols } = await listSymbols(JAVA_ROOT, path.join(JAVA_ROOT, 'com', 'example', 'Order.java'));
  const names = symbols.map((s) => s.name);
  check('Order.java 含类/构造/方法/字段', contains(names.join(','), 'Order', 'getId', 'getName', 'id', 'name'), names.join(','));
  check('getId 容器为 Order', symbols.some((s) => s.name === 'getId' && s.container === 'Order'));
  check('id 是 property', symbols.some((s) => s.name === 'id' && s.kind === 'property'));
}

{
  const { symbols } = await listSymbols(C_ROOT, path.join(C_ROOT, 'util.h'));
  const names = symbols.map((s) => s.name);
  check('util.h 含宏/结构体/函数原型', contains(names.join(','), 'MAX_SIZE', 'Point', 'add', 'multiply'), names.join(','));
  check('MAX_SIZE 是 macro', symbols.some((s) => s.name === 'MAX_SIZE' && s.kind === 'macro'));
}

{
  const { symbols } = await listSymbols(C_ROOT, path.join(C_ROOT, 'util.c'));
  const names = symbols.map((s) => s.name);
  check('util.c 含 add/multiply 定义', contains(names.join(','), 'add', 'multiply'), names.join(','));
  check('add 是 function', symbols.some((s) => s.name === 'add' && s.kind === 'function'));
}

{
  const { symbols } = await listSymbols(C_ROOT, path.join(C_ROOT, 'main.c'));
  const names = symbols.map((s) => s.name);
  check('main.c 含全局变量与 main', contains(names.join(','), 'counter', 'main'), names.join(','));
  check('counter 是 variable', symbols.some((s) => s.name === 'counter' && s.kind === 'variable'));
}

// ─── 2. read_symbol ──────────────────────────────────────────
console.log('\n▶ read_symbol');

{
  const out = await readSymbol(JAVA_ROOT, path.join(JAVA_ROOT, 'com', 'example', 'Order.java'), 'Order.getId');
  check('Order.getId 读到方法体', contains(out, 'getId', 'return id'), out.slice(0, 200));
}

{
  const out = await readSymbol(JAVA_ROOT, path.join(JAVA_ROOT, 'com', 'example', 'Main.java'), 'Main');
  check('Main 类定义可读', contains(out, 'Main', 'main'), out.slice(0, 200));
}

{
  const out = await readSymbol(C_ROOT, path.join(C_ROOT, 'util.c'), 'add');
  check('add 读到函数定义（非原型）', contains(out, 'add', 'a + b'), out.slice(0, 200));
}

{
  const out = await readSymbol(C_ROOT, path.join(C_ROOT, 'util.h'), 'MAX_SIZE');
  check('MAX_SIZE 宏定义可读', contains(out, 'MAX_SIZE', '128'), out.slice(0, 200));
}

// ─── 3. find_references ──────────────────────────────────────
console.log('\n▶ find_references');

{
  const { refs, total } = await findReferences(JAVA_ROOT, 'total');
  check('total 有引用', total > 0, `total=${total}`);
  check('引用含 Main.java 调用点', refs.some((r) => r.file.endsWith('Main.java')), JSON.stringify(refs.map((r) => r.file)));
}

{
  const { refs, total } = await findReferences(C_ROOT, 'add');
  check('add 有跨文件引用', total > 0, `total=${total}`);
  check('引用含 main.c', refs.some((r) => r.file.endsWith('main.c')), JSON.stringify(refs.map((r) => r.file)));
  check('引用不含声明本身', !refs.some((r) => r.file.endsWith('util.c') && r.line === 3), JSON.stringify(refs));
}

// ─── 4. trace_callers ────────────────────────────────────────
console.log('\n▶ trace_callers');

{
  const { callers, total } = await traceCallers(JAVA_ROOT, path.join(JAVA_ROOT, 'com', 'example', 'Service.java'), 'total');
  check('total 有调用方', total > 0, `total=${total}`);
  check('调用方是 Main.main', callers.some((c) => c.file.endsWith('Main.java') && c.callerName === 'main'), JSON.stringify(callers));
}

{
  const { callers, total } = await traceCallers(C_ROOT, path.join(C_ROOT, 'util.c'), 'add');
  check('add 有调用方', total > 0, `total=${total}`);
  check('调用方含 multiply 与 main', callers.some((c) => c.callerName === 'multiply') && callers.some((c) => c.callerName === 'main'), JSON.stringify(callers));
}

// ─── 5. trace_callees ────────────────────────────────────────
console.log('\n▶ trace_callees');

{
  const { callees, total } = await traceCallees(JAVA_ROOT, path.join(JAVA_ROOT, 'com', 'example', 'Main.java'), 'main');
  const names = callees.map((c) => c.name);
  check('main 调用 Order/Service 构造与 total', contains(names.join(','), 'Order', 'Service', 'total'), names.join(','));
  check('main 至少 3 个调用', total >= 3, `total=${total}`);
}

{
  const { callees, total } = await traceCallees(C_ROOT, path.join(C_ROOT, 'main.c'), 'main');
  const names = callees.map((c) => c.name);
  check('main 调用 add/multiply/printf', contains(names.join(','), 'add', 'multiply', 'printf'), names.join(','));
  check('main 恰好 3 个调用', total === 3, `total=${total}`);
}

{
  const { callees, total } = await traceCallees(C_ROOT, path.join(C_ROOT, 'util.c'), 'add');
  check('add 内部无调用', total === 0, `total=${total}`);
}

// ─── 6. trace_chain ──────────────────────────────────────────
console.log('\n▶ trace_chain');

{
  const { chain, truncated } = await traceChain(C_ROOT, path.join(C_ROOT, 'main.c'), 'main', 3);
  check('调用链以 main 为根', chain.length >= 1 && chain[0].name === 'main', JSON.stringify(chain));
  check('深度 3 不截断', !truncated);
}

{
  const { chain, truncated } = await traceChain(JAVA_ROOT, path.join(JAVA_ROOT, 'com', 'example', 'Main.java'), 'main', 1);
  check('深度 1 只有根', chain.length === 1, `chain=${chain.length}`);
  check('深度 1 截断标记', truncated);
}

// ─── 7. file_deps ────────────────────────────────────────────
console.log('\n▶ file_deps');

{
  const { deps } = await fileDeps(JAVA_ROOT, path.join(JAVA_ROOT, 'com', 'example', 'Main.java'));
  check('Main.java 依赖 Order/Service', deps.length >= 2, `deps=${deps.length}`);
  const order = deps.find((d) => d.to.endsWith('Order.java'));
  check('Order 解析为本地文件', !!order && !order.external, JSON.stringify(deps));
  check('依赖都有行号', deps.every((d) => d.line > 0));
}

{
  const { deps } = await fileDeps(C_ROOT, path.join(C_ROOT, 'main.c'));
  check('main.c 依赖 stdio 与 util.h', deps.length === 2, `deps=${deps.length}`);
  const stdio = deps.find((d) => d.to.includes('stdio'));
  const util = deps.find((d) => d.to === 'util.h');
  check('stdio 是外部依赖', !!stdio && stdio.external, JSON.stringify(deps));
  check('util.h 解析为本地文件', !!util && !util.external, JSON.stringify(deps));
}

// ─── 8. blast_radius ─────────────────────────────────────────
console.log('\n▶ blast_radius');

{
  const { hits, files, total } = await blastRadius(JAVA_ROOT, path.join(JAVA_ROOT, 'com', 'example', 'Service.java'));
  check('改 Service.java 影响 Main.java', total > 0 && files.some((f) => f.endsWith('Main.java')), JSON.stringify(files));
}

{
  const { hits, files, total } = await blastRadius(C_ROOT, path.join(C_ROOT, 'util.h'));
  check('改 util.h 影响 util.c 与 main.c', total >= 2 && files.some((f) => f.endsWith('util.c')) && files.some((f) => f.endsWith('main.c')), JSON.stringify(files));
}

{
  const { hits, total } = await blastRadius(C_ROOT, path.join(C_ROOT, 'util.c'), 'add');
  check('改 add 符号影响 main.c', total > 0 && hits.some((h) => h.file.endsWith('main.c')), JSON.stringify(hits.slice(0, 3)));
}

// ─── 9. 语言分发边界 ────────────────────────────────────────
console.log('\n▶ 语言分发');

{
  const { symbols } = await listSymbols(FIXTURE, path.join(FIXTURE, 'demo', 'src', 'com', 'example', 'Order.java'));
  check('通过 FIXTURE 根也能解析 Java 文件', symbols.some((s) => s.name === 'getId'));
}

{
  const { refs, total } = await findReferences(FIXTURE, 'add');
  check('不带 targetFile 自动探测 C 语言', total > 0 && refs.some((r) => r.file.endsWith('main.c')), `total=${total}`);
}

// ─── 汇总 ────────────────────────────────────────────────────
console.log(`\n═══ 结果: ${passed} 通过, ${failed} 失败 ═══`);
if (failed > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
