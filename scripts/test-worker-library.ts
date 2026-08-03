/**
 * test-worker-library.ts — 预制员工库功能测试
 *
 * 验证 list_workers / get_worker 工具能正确扫描并解析 src/prompts/workers/*.md：
 *  - 能列出全部 6 位员工
 *  - 每位员工的 systemPrompt 模板非空且含标记
 *  - 每位员工的推荐工具组是合法 JSON 数组，且工具名在全局注册表中存在
 *
 * 运行：npx tsx scripts/test-worker-library.ts
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

async function main() {
  // ── 1. 静态检查 md 文件 ──
  console.log('\n[1] workers 目录文件检查');
  const workersDir = path.join(root, 'src', 'prompts', 'workers');
  const files = fs.readdirSync(workersDir).filter((f) => f.endsWith('.md'));
  const expected = [
    'code-implementer', 'code-reviewer', 'bug-fixer',
    'tester', 'researcher', 'documenter', 'social-fish',
  ];
  for (const id of expected) {
    assert(files.includes(`${id}.md`), `员工文件存在: ${id}.md`);
  }

  // ── 2. 每个文件结构检查 ──
  console.log('\n[2] 员工文件结构检查（标记完整性）');
  for (const id of expected) {
    const content = fs.readFileSync(path.join(workersDir, `${id}.md`), 'utf-8');
    assert(/^#\s+.+\([a-z0-9-]+\)\s*$/m.test(content), `${id}: 标题行格式正确`);
    assert(content.includes('## 名字'), `${id}: 含名字字段`);
    assert(content.includes('## 性格'), `${id}: 含性格字段`);
    const nameMatch = content.match(/##\s*名字\s*\n([^\n#]+)/);
    assert(!!nameMatch && nameMatch[1].trim().length > 0, `${id}: 名字非空`);
    const personalityMatch = content.match(/##\s*性格\s*\n([\s\S]*?)(?=\n##\s|\n----|$)/);
    assert(!!personalityMatch && personalityMatch[1].trim().length > 5, `${id}: 性格描述非空`);
    assert(content.includes('## 角色定位'), `${id}: 含角色定位`);
    assert(content.includes('## 适用场景'), `${id}: 含适用场景`);
    assert(content.includes('----SYSTEM_PROMPT_START----') && content.includes('----SYSTEM_PROMPT_END----'), `${id}: 含 systemPrompt 标记`);
    assert(content.includes('----TOOLS_START----') && content.includes('----TOOLS_END----'), `${id}: 含工具组标记`);

    const sp = content.match(/----SYSTEM_PROMPT_START----\s*\n([\s\S]*?)\n----SYSTEM_PROMPT_END----/);
    assert(!!sp && sp[1].trim().length > 100, `${id}: systemPrompt 模板非空且足够详细`);

    const tm = content.match(/----TOOLS_START----\s*\n([\s\S]*?)\n----TOOLS_END----/);
    let tools: string[] = [];
    if (tm) {
      try {
        tools = JSON.parse(tm[1].trim());
      } catch {
        tools = [];
      }
    }
    assert(Array.isArray(tools) && tools.length >= 5, `${id}: 推荐工具组为 JSON 数组且 ≥5 个工具`);
  }

  // ── 3. 工具名在全局注册表中存在 ──
  console.log('\n[3] 推荐工具名有效性检查');
  // 从 worker-library/index.ts 与核心注册表读取工具名（静态清单，避免加载整个 tools 容器）
  const coreNames = [
    'read_file', 'read_lines', 'scan_file',
    'execute_command', 'search_all_file', 'search_sub_file', 'search_directory', 'search_content',
    'create_file', 'replace_file', 'add_patch', 'del_patch', 'modify_patch', 'undo_patch', 'history_patch',
    'desk_add', 'desk_list', 'desk_remove', 'desk_clear',
    'create_todo', 'finish_step', 'undo_step', 'reroll_step', 'del_step', 'read_todo', 'del_todo', 'active_todo',
    'memory_add', 'memory_update', 'memory_touch', 'memory_remove', 'memory_list',
    'memory_remember', 'memory_recall', 'memory_clear', 'memory_stats', 'memory_focus', 'memory_shorten',
    'collab_sessions', 'collab_send',
  ];
  const skillNames = [
    'search_web', 'fetch_page', 'extract_links', 'crawl_site',
    'kb_query', 'kb_status', 'kb_build_index',
    'spawn_agent', 'agent_task', 'agent_query', 'agent_fire', 'a_submission',
    // browser-control 系列
    'browser_launch', 'browser_navigate', 'browser_click', 'browser_type', 'browser_press',
    'browser_scroll', 'browser_extract', 'browser_screenshot', 'browser_execute_js',
    'browser_wait', 'browser_status', 'browser_close',
    // tavily 系列
    'tavily_search', 'tavily_extract', 'tavily_crawl', 'tavily_map', 'tavily_research',
    // 识图系列
    'image_info', 'extract_image_text', 'vision_analyze', 'extract_images', 'filter_images', 'download_images',
  ];
  const known = new Set([...coreNames, ...skillNames]);
  for (const id of expected) {
    const content = fs.readFileSync(path.join(workersDir, `${id}.md`), 'utf-8');
    const tm = content.match(/----TOOLS_START----\s*\n([\s\S]*?)\n----TOOLS_END----/);
    if (!tm) continue;
    let tools: string[] = [];
    try { tools = JSON.parse(tm[1].trim()); } catch { /* ignore */ }
    const unknown = tools.filter((t) => !known.has(t));
    assert(unknown.length === 0, `${id}: 工具名全部在注册表中${unknown.length ? `（未知: ${unknown.join(', ')}）` : ''}`);
  }

  // ── 4. 动态验证：实际调用工具（模拟子模型工具加载方式） ──
  console.log('\n[4] 动态加载验证（worker-library 工具可导入）');
  try {
    const mod: any = await import('../src/tools/inner_skills/worker-library/index.ts');
    const tools = mod.default || mod;
    const names = Object.keys(tools).sort();
    assert(
      names.includes('list_workers') && names.includes('get_worker') && names.includes('worker-library-prompt-get'),
      `工具注册齐全: ${names.join(', ')}`,
    );

    const listOut = await tools['list_workers'].execute({});
    assert(typeof listOut === 'string' && listOut.includes('7 名员工'), 'list_workers 列出 7 名员工');

    const getOut = await tools['get_worker'].execute({ id: 'researcher' });
    assert(typeof getOut === 'string' && getOut.includes('调研分析员'), 'get_worker(researcher) 返回调研分析员资料');
    assert(getOut.includes('【systemPrompt'), 'get_worker 含 systemPrompt 段落');
    assert(getOut.includes('【推荐工具组'), 'get_worker 含推荐工具组段落');
    assert(getOut.includes('search_web'), 'get_worker 工具组含 web 检索工具');

    const missingOut = await tools['get_worker'].execute({ id: 'no-such-worker' });
    assert(typeof missingOut === 'string' && missingOut.includes('未找到员工'), 'get_worker 未知 id 友好报错');
  } catch (err: any) {
    assert(false, `动态加载失败: ${err.message}`);
  }

  // ── 5. spawn_worker 验证 ──
  console.log('\n[5] spawn_worker 验证（一键创建 mission 子模型）');
  try {
    const tools: any = (await import('../src/tools/inner_skills/worker-library/index.ts')).default;
    assert(typeof tools['spawn_worker']?.execute === 'function', 'spawn_worker 工具已注册');

    // 有效员工创建（显式 name）
    const out = await tools['spawn_worker'].execute({
      worker: 'tester',
      name: 'test-worker-e2e',
      contextAndTask: '背景：为某模块补测试',
    });
    assert(typeof out === 'string' && out.includes('✅'), `spawn_worker 创建成功: ${out.split('\n')[0]}`);
    assert(out.includes('测测') && out.includes('测试工程师'), '返回含员工名字与标题');
    assert(out.includes('天生较真'), '返回含性格摘要');

    // 校验 subAgentManager 中的 agent 配置
    const managerMod: any = await import('../src/tools/inner_skills/sub-agent/manager.ts');
    const agent = managerMod.subAgentManager.get('test-worker-e2e');
    assert(!!agent, '子模型已注册到 subAgentManager');
    assert(agent?.mode === 'mission', `固定 mission 模式（实际: ${agent?.mode}）`);

    // 与员工文件工具组一致
    const workerContent = fs.readFileSync(path.join(workersDir, 'tester.md'), 'utf-8');
    const tm = workerContent.match(/----TOOLS_START----\s*\n([\s\S]*?)\n----TOOLS_END----/);
    const fileTools = tm ? JSON.parse(tm[1].trim()) : [];
    assert(JSON.stringify(agent?.tools) === JSON.stringify(fileTools), 'tools 与员工文件推荐工具组一致');
    assert(!!agent?.systemPrompt && agent.systemPrompt.includes('测试工程师'), 'systemPrompt 从员工库自动装配');
    assert(agent?.systemPrompt.includes('你的名字叫「测测」'), '身份段（名字）已注入 systemPrompt');
    assert(agent?.systemPrompt.includes('天生较真'), '身份段（性格）已注入 systemPrompt');
    assert(agent?.context === '背景：为某模块补测试', 'contextAndTask 透传为 context');

    // 省略 name → 用员工默认名字
    const defaultOut = await tools['spawn_worker'].execute({ worker: 'researcher', contextAndTask: '背景：调研' });
    assert(typeof defaultOut === 'string' && defaultOut.includes('"小研"'), `省略 name 时用员工默认名字: ${defaultOut.split('\n')[0]}`);
    const defaultAgent = managerMod.subAgentManager.get('小研');
    assert(!!defaultAgent && defaultAgent.mode === 'mission', '默认名字的子模型已创建');
    assert(defaultAgent?.systemPrompt.includes('小研'), '默认名字子模型身份段含名字');
    managerMod.subAgentManager.fire('小研');

    // 无效员工
    const badOut = await tools['spawn_worker'].execute({ worker: 'no-such', name: 'x' });
    assert(typeof badOut === 'string' && badOut.includes('未找到预制员工'), 'spawn_worker 未知员工友好报错');

    // 清理
    managerMod.subAgentManager.fire('test-worker-e2e');
    console.log('  （已清理测试子模型）');
  } catch (err: any) {
    assert(false, `spawn_worker 验证失败: ${err.message}`);
  }


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













