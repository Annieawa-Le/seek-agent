/**
 * test-instructor-flow.ts — instructor 异步信号机制回归测试
 *
 * 覆盖：
 *  1. 建议消息识别正则（【xxx 建议】开头 → 鲸鱼气泡分支）
 *  2. 建议头部剥离（显示时去掉【name 建议】头，只留内容）
 *  3. manager 对 instructor 后台流的中断（abortAllInstructors / fire）
 *  4. ensureProcessingLoop 竞态兜底语义（loop 退出中时建议不滞留）
 *  5. countUserInputs 过滤约定（建议不算真实用户输入）
 */
import { subAgentManager } from '../src/tools/inner_skills/sub-agent/manager';
import type { SubAgentState } from '../src/tools/inner_skills/sub-agent/types';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name} ${detail}`); }
}

// ── 1) 建议识别正则（与 agent.ts registerUserInput 一致） ──
console.log('1) 建议消息识别（registerUserInput 分支逻辑）');
const SUGGEST_RE = /^【(.+?) 建议】\n?/;
{
  const input = '【鲸鱼教练 建议】\n1. 补充测试\n2. 检查边界';
  const m = input.match(SUGGEST_RE);
  check('【name 建议】开头命中', !!m, `match=${m}`);
  check('捕获名字', m?.[1] === '鲸鱼教练', `name=${m?.[1]}`);
  check('剥离头部后是纯内容', input.slice(m![0].length) === '1. 补充测试\n2. 检查边界', input.slice(m![0].length));
  check('普通用户输入不命中', !'帮我修个 bug'.match(SUGGEST_RE));
  check('【子模型提交】不误判（无空格建议）', !'【小码 提交工作结果】xxx'.match(SUGGEST_RE));
  check('名字含空格也可识别', !!'【开发 指导 教练 建议】xxx'.match(SUGGEST_RE));
  check('无换行头也可识别', !!'【鲸鱼 建议】纯文本'.match(SUGGEST_RE));
}

// ── 2) 轮次重置正则（真实输入 → 重置计数） ──
console.log('2) 轮次重置判定');
{
  const isSuggest = (s: string) => /^【.* 建议】/.test(s);
  check('建议消息不重置计数', isSuggest('【鲸鱼 建议】\n继续'));
  check('真实输入重置计数', !isSuggest('帮我分析这段代码'));
  check('提交消息不算建议（保持计数）', !isSuggest('【小码 提交工作结果】\n完成'));
}

// ── 3) manager 中断 instructor 后台流 ──
console.log('3) instructor 后台流中断');
{
  const aborted: string[] = [];
  const mkController = (name: string) => ({ abort: () => aborted.push(name), signal: {} as AbortSignal });
  subAgentManager.spawn({ mode: 'instructor', name: '教练A', tools: [] });
  subAgentManager.spawn({ mode: 'mission', name: '打工人B', tools: [] });
  const instA = subAgentManager.get('教练A')!;
  const workerB = subAgentManager.get('打工人B')!;
  instA.instructorAbortController = mkController('教练A') as any;
  workerB.instructorAbortController = mkController('打工人B') as any;

  subAgentManager.abortAllInstructors();
  check('abortAllInstructors 只中断 instructor', aborted.length === 1 && aborted[0] === '教练A', aborted.join(','));

  // fire 时中断
  aborted.length = 0;
  instA.instructorAbortController = mkController('教练A2') as any;
  subAgentManager.fire('教练A');
  check('fire 中断被销毁的 instructor', aborted.length === 1 && aborted[0] === '教练A2', aborted.join(','));

  subAgentManager.fireAll();
}

// ── 4) ensureProcessingLoop 竞态兜底语义（模拟） ──
console.log('4) ensureProcessingLoop 竞态兜底');
{
  // 模拟：processingPromise 非空但 loop 即将退出（finally 未执行）
  let loopStarts = 0;
  const fakeRunProcessingLoop = async () => { loopStarts++; };
  let processingPromise: Promise<void> | null = null;
  const inputQueue: string[] = [];

  const ensure = () => {
    if (!processingPromise) {
      processingPromise = fakeRunProcessingLoop().finally(() => { processingPromise = null; });
      return;
    }
    queueMicrotask(() => {
      if (!processingPromise && inputQueue.length > 0) {
        processingPromise = fakeRunProcessingLoop().finally(() => { processingPromise = null; });
      }
    });
  };

  // 场景A：loop 正在跑（promise 未 resolve）→ 不启动新 loop
  processingPromise = new Promise<void>(() => {}); // 永不 resolve 的进行中 loop
  inputQueue.push('建议A');
  ensure();
  check('loop 活跃时不重复启动', loopStarts === 0);
  await Promise.resolve(); // 让微任务跑完
  check('活跃 loop 的微任务兜底不误启', loopStarts === 0);

  // 场景B：loop 即将退出（promise 已 resolve，finally 尚未执行）
  {
    let resolveLoop: () => void = () => {};
    processingPromise = new Promise<void>(r => { resolveLoop = r; }).finally(() => { processingPromise = null; });
    resolveLoop(); // resolve → finally 微任务入队
    inputQueue.push('建议B');
    ensure();
    check('退出中不直接启动（等微任务）', loopStarts === 0);
    await Promise.resolve(); // finally 执行 → processingPromise = null
    await Promise.resolve(); // 兜底微任务执行 → 启动新 loop
    check('退出后兜底启动新 loop', loopStarts === 1, `loopStarts=${loopStarts}`);
    await Promise.resolve(); // 新 loop（fake）finally 置 null
    check('兜底后 processingPromise 复位', processingPromise === null);
  }

  // 场景C：完全空闲 → 直接启动
  inputQueue.push('建议C');
  ensure();
  check('空闲时直接启动', loopStarts === 2, `loopStarts=${loopStarts}`);
  await Promise.resolve();
}

// ── 5) countUserInputs 过滤约定（建议不算真实输入） ──
console.log('5) 建议不计入真实用户输入');
{
  const messages = [
    { role: 'user', content: '真实问题' },
    { role: 'user', content: '【鲸鱼教练 建议】\n补充测试' },
    { role: 'user', content: '【小码 提交工作结果】\n完成' },
  ];
  const count = messages.filter(
    (m: any) => m.role === 'user' && typeof m.content === 'string'
      && !m.content.startsWith('[工作记忆]')
      && !m.content.startsWith('【')
      && !m.content.startsWith('[知识库检索]')
      && !m.content.startsWith('[Worklog#'),
  ).length;
  check('只有真实输入计数', count === 1, `count=${count}`);
}

// ── 6) 提示词模板加载（src/prompts/INSTRUCTOR.md 自定义） ──
console.log('6) instructor 提示词模板加载');
{
  const { loadInstructorPrompt } = await import('../src/tools/inner_skills/sub-agent/runner');
  const req = '对下一步开发提出建设性建议';
  const extra = '\n\n额外指导：\n重点关注性能';
  const prompt = loadInstructorPrompt(req, extra);
  check('模板来自文件（含标题或正文）', prompt.includes('Instructor') || prompt.includes('你是一个开发'), prompt.slice(0, 40));
  check('requirement 占位符已替换', prompt.includes(req) && !prompt.includes('{{requirement}}'));
  check('extraInstruction 占位符已替换', prompt.includes('重点关注性能') && !prompt.includes('{{extraInstruction}}'));
  check('HTML 注释已剥离', !prompt.includes('<!--') && !prompt.includes('可用占位符'), prompt.slice(0, 60));
  const prompt2 = loadInstructorPrompt(req, '');
  check('无额外指导时为空', !prompt2.includes('{{extraInstruction}}') && !prompt2.includes('undefined'));
  const prompt3 = loadInstructorPrompt('自定义要求XYZ', '');
  check('占位符替换无残留', prompt3.includes('自定义要求XYZ') && !prompt3.includes('{{requirement}}'), prompt3.slice(0, 40));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);




