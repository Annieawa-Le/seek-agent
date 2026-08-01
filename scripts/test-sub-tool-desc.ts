/**
 * test-sub-tool-desc.ts — 子模型工具用途简述注入验证
 *
 * 验证两件事：
 *  1. src/tools/index.ts 新增的 getSkillToolMap / getSkillInjectionForTool 可用，
 *     工具→skill 反查 + SYSTEM_INJECTION.md 读取正确
 *  2. 全局注册表中每个工具都有可提取的 description 首行（"一句话用途"的数据源），
 *     模拟 runner.ts buildToolIdentityDesc 的输出格式
 *
 * 运行：npx tsx scripts/test-sub-tool-desc.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

/** 模拟 runner.ts buildToolIdentityDesc 的单行描述提取 */
function firstLineDesc(rawDesc: string | undefined): string {
  if (typeof rawDesc !== 'string') return '';
  const firstLine = rawDesc.trim().split('\n')[0]?.trim() ?? '';
  return firstLine.length > 64 ? firstLine.slice(0, 61) + '…' : firstLine;
}

async function main() {
  const mod: any = await import('../src/tools/index.ts');
  const tools = mod.tools as Record<string, any>;

  // ── 1. index.ts 新导出 ──
  console.log('\n[1] index.ts 工具→skill 反查导出');
  assert(typeof mod.getSkillToolMap === 'function', 'getSkillToolMap 已导出');
  assert(typeof mod.getSkillInjectionForTool === 'function', 'getSkillInjectionForTool 已导出');

  const skillMap: Record<string, string[]> = mod.getSkillToolMap();
  assert(Object.keys(skillMap).length >= 20, `skillToolMap 覆盖 ${Object.keys(skillMap).length} 个技能`);
  assert(Array.isArray(skillMap['worker-library']) && skillMap['worker-library'].includes('spawn_worker'), 'worker-library 技能映射含 spawn_worker');
  assert(Array.isArray(skillMap['browser-control']) && skillMap['browser-control'].includes('browser_launch'), 'browser-control 技能映射含 browser_launch');
  assert(Array.isArray(skillMap['sub-agent']) && skillMap['sub-agent'].includes('spawn_agent'), 'sub-agent 技能映射含 spawn_agent');

  // ── 2. SYSTEM_INJECTION.md 注入 ──
  console.log('\n[2] 技能 SYSTEM_INJECTION.md 注入');
  const browserInj = await mod.getSkillInjectionForTool('browser_launch');
  assert(typeof browserInj === 'string' && browserInj.length > 50, `browser_launch → browser-control 注入非空（${browserInj.length} 字符）`);
  assert(browserInj.includes('browser'), 'browser-control 注入内容含技能说明');

  const coreInj = await mod.getSkillInjectionForTool('read_file');
  assert(coreInj === '', '核心工具 read_file 不属于任何 skill → 注入为空');

  const workerInj = await mod.getSkillInjectionForTool('list_workers');
  assert(typeof workerInj === 'string' && workerInj.includes('预制员工库'), 'list_workers → worker-library 注入非空');

  // ── 3. 员工工具组全部有 description 首行（一句话用途数据源） ──
  console.log('\n[3] 预制员工工具组的"一句话用途"可用性');
  const workersDir = path.join(root, 'src', 'prompts', 'workers');
  const workerFiles = fs.readdirSync(workersDir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
  for (const file of workerFiles) {
    const content = fs.readFileSync(path.join(workersDir, file), 'utf-8');
    const tm = content.match(/----TOOLS_START----\s*\n([\s\S]*?)\n----TOOLS_END----/);
    if (!tm) continue;
    let toolNames: string[] = [];
    try { toolNames = JSON.parse(tm[1].trim()); } catch { /* ignore */ }
    const noDesc = toolNames.filter((t) => {
      const impl = tools[t];
      return !impl || firstLineDesc(impl?.description).length === 0;
    });
    assert(noDesc.length === 0, `${file}: ${toolNames.length} 个工具全部有 description 首行${noDesc.length ? `（缺: ${noDesc.join(', ')}）` : ''}`);
  }

  // ── 4. 模拟 buildToolIdentityDesc 输出 ──
  console.log('\n[4] 模拟 buildToolIdentityDesc（小鱼 41 工具）');
  const fishContent = fs.readFileSync(path.join(workersDir, 'social-fish.md'), 'utf-8');
  const fishTm = fishContent.match(/----TOOLS_START----\s*\n([\s\S]*?)\n----TOOLS_END----/);
  const fishTools: string[] = fishTm ? JSON.parse(fishTm[1].trim()) : [];
  const lines = fishTools.map((name) => {
    const desc = firstLineDesc(tools[name]?.description);
    return desc ? `- ${name}：${desc}` : `- ${name}`;
  });
  assert(lines.length === fishTools.length, `生成 ${lines.length} 行工具用途`);
  assert(lines.every((l) => l.startsWith('- ')), '每行以 "- " 开头');
  assert(lines.some((l) => l.includes('browser_launch：') && l.length > 30), 'browser_launch 行含用途描述');
  assert(lines.some((l) => l.includes('vision_analyze：')), 'vision_analyze 行含用途描述');
  console.log('  样例：');
  console.log('    ' + lines[0]);
  console.log('    ' + lines.find((l) => l.includes('browser_navigate')));

  // ── 汇总 ──
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('失败项:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
