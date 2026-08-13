/**
 * worker-library — 预制员工库
 *
 * Manager 模式拆解任务后，可从此处获取预制员工模板直接 spawn_agent。
 * 员工资料存放在 src/prompts/workers/*.md，每个文件包含：
 *   - ## 名字 / ## 性格（员工人设，spawn_worker 自动注入 systemPrompt）
 *   - ## 角色定位 / ## 适用场景（人读）
 *   - ----SYSTEM_PROMPT_START/END---- 包裹的 systemPrompt 模板（可直接用于 spawn_agent）
 *   - ----TOOLS_START/END---- 包裹的推荐工具组（JSON 数组，可直接用于 spawn_agent 的 tools）
 *
 * 提供三个工具：
 *   list_workers — 列出全部预制员工（名字、角色、性格摘要、工具数）
 *   get_worker   — 读取单个员工的完整资料（名字/性格 + systemPrompt 模板 + 推荐工具组）
 *   spawn_worker — 从员工库一键创建 mission 子模型（身份 + 提示词 + 工具自动装配，name 可省略，支持 skills 参数解锁技能工具）
 */
import { tool } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subAgentManager } from '../sub-agent/manager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 定位 workers 目录：源码模式下相对 skill 位置；失败时回退到进程 cwd */
async function resolveWorkersDir(): Promise<string> {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'prompts', 'workers'),
    path.join(process.cwd(), 'src', 'prompts', 'workers'),
  ];
  for (const dir of candidates) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return dir;
    } catch {
      // 尝试下一个候选路径
    }
  }
  return candidates[0];
}

interface ParsedWorker {
  id: string;
  title: string;
  name: string;
  personality: string;
  role: string;
  scenarios: string;
  systemPrompt: string;
  tools: string[];
  skills: string[];
}
/** 解析单个员工 md 文件为结构化数据 */
function parseWorker(content: string): ParsedWorker {
  const titleMatch = content.match(/^#\s+(.+?)\s*\(([a-z0-9-]+)\)\s*$/m);
  const nameMatch = content.match(/##\s*名字\s*\n([^\n#]+)/);
  const personalityMatch = content.match(/##\s*性格\s*\n([\s\S]*?)(?=\n##\s|\n----|$)/);
  const roleMatch = content.match(/##\s*角色定位\s*\n([\s\S]*?)(?=\n##\s|\n----|$)/);
  const scenariosMatch = content.match(/##\s*适用场景\s*\n([\s\S]*?)(?=\n##\s|\n----|$)/);
  const spMatch = content.match(/----SYSTEM_PROMPT_START----\s*\n([\s\S]*?)\n----SYSTEM_PROMPT_END----/);
  const toolsMatch = content.match(/----TOOLS_START----\s*\n([\s\S]*?)\n----TOOLS_END----/);
  const skillsMatch = content.match(/----SKILLS_START----\s*\n([\s\S]*?)\n----SKILLS_END----/);

  let tools: string[] = [];
  if (toolsMatch) {
    try {
      const parsed = JSON.parse(toolsMatch[1].trim());
      if (Array.isArray(parsed)) tools = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      tools = [];
    }
  }

  let skills: string[] = [];
  if (skillsMatch) {
    try {
      const parsed = JSON.parse(skillsMatch[1].trim());
      if (Array.isArray(parsed)) skills = parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      skills = [];
    }
  }

  return {
    id: titleMatch?.[2] ?? path.basename(content, '.md'),
    title: titleMatch?.[1]?.trim() ?? '未知员工',
    name: nameMatch?.[1]?.trim() ?? '',
    personality: personalityMatch?.[1]?.trim() ?? '',
    role: roleMatch?.[1]?.trim() ?? '',
    scenarios: scenariosMatch?.[1]?.trim() ?? '',
    systemPrompt: spMatch?.[1]?.trim() ?? '',
    tools,
    skills,
  };
}

/** 生成子模型身份段（名字 + 性格），spawn_worker 时拼接到 systemPrompt 前 */
function buildIdentity(w: ParsedWorker): string {
  const parts: string[] = [];
  if (w.name) parts.push(`你的名字叫「${w.name}」，是一名${w.title}。`);
  if (w.personality) parts.push(`性格特点：${w.personality}`);
  return parts.length > 0 ? parts.join('\n') : '';
}

/** 动态导入 index 模块获取全局工具注册表（避免循环依赖） */
async function getIndexModule(): Promise<any> {
  try {
    return await import('../../index');
  } catch {
    return {};
  }
}

/**
 * 解析技能名列表，收集每项技能的工具、描述（enable.json）与使用说明（SYSTEM_INJECTION.md）。
 * 自动激活懒加载技能，确保工具已注册到系统。
 */
async function resolveSkillDetails(skillNames: string[]): Promise<{
  mergedTools: string[];
  skillSection: string;
}> {
  if (!skillNames || skillNames.length === 0) {
    return { mergedTools: [], skillSection: '' };
  }

  const mod = await getIndexModule();
  const ensureSkillActivated = (mod as any)?.ensureSkillActivated;
  const skillsDir = path.join(__dirname, '..', '..', 'inner_skills');

  const allToolNames: string[] = [];
  const descLines: string[] = [];
  const injectionParts: string[] = [];

  for (const skillName of skillNames) {
    // 1. 确保技能已激活，获取工具名列表
    let toolNames: string[] = [];
    if (ensureSkillActivated) {
      toolNames = ensureSkillActivated(skillName) || [];
    }
    if (toolNames.length === 0) {
      descLines.push(`- **${skillName}**：未找到该技能（可能未启用或不存在）`);
    } else {
      allToolNames.push(...toolNames);
    }

    // 2. 读取 enable.json 获取技能描述
    const enablePath = path.join(skillsDir, skillName, 'enable.json');
    try {
      const enableContent = await fs.readFile(enablePath, 'utf-8');
      const enableConfig = JSON.parse(enableContent);
      if (enableConfig.description) {
        descLines.push(`- **${skillName}**：${enableConfig.description}`);
      } else {
        descLines.push(`- **${skillName}**`);
      }
    } catch {
      descLines.push(`- **${skillName}**`);
    }

    // 3. 读取 SYSTEM_INJECTION.md
    const injPath = path.join(skillsDir, skillName, 'SYSTEM_INJECTION.md');
    try {
      const injContent = await fs.readFile(injPath, 'utf-8');
      if (injContent.trim()) {
        injectionParts.push(`### ${skillName} 使用说明`, '', injContent.trim());
      }
    } catch {
      // 没有 SYSTEM_INJECTION.md，跳过
    }
  }

  // 构建技能描述段落
  let skillSection = '';
  if (descLines.length > 0) {
    skillSection = `\n\n## 已解锁技能\n\n以下技能已为您解锁全部工具，您可以直接使用它们的所有功能：\n\n${descLines.join('\n')}`;
    if (injectionParts.length > 0) {
      skillSection += `\n\n### 相关技能使用说明\n\n${injectionParts.join('\n\n')}`;
    }
  }

  return { mergedTools: allToolNames, skillSection };
}


async function loadAllWorkers(): Promise<ParsedWorker[]> {
  const dir = await resolveWorkersDir();
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
  const workers: ParsedWorker[] = [];
  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(dir, file), 'utf-8');
      workers.push(parseWorker(content));
    } catch {
      // 单个文件解析失败跳过
    }
  }
  return workers;
}

const tools: Record<string, any> = {};

// ═════════════════════════════════════════════════════
// list_workers — 列出全部预制员工
// ═════════════════════════════════════════════════════

tools['list_workers'] = tool({
  description: `列出预制员工库中的全部员工（名字、角色、性格摘要、推荐工具数）。Manager 模式拆解任务后先调用本工具查看可选员工，再用 get_worker 获取单个员工的完整资料或用 spawn_worker 一键创建。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const workers = await loadAllWorkers();
      if (workers.length === 0) {
        return '预制员工库为空（未找到 src/prompts/workers/*.md）。';
      }
      const lines: string[] = [
        `预制员工库共 ${workers.length} 名员工：`,
        '',
      ];
      for (const w of workers) {
        const toolDesc = w.tools.length > 0 ? `${w.tools.length} 个工具` : '（未配置工具）';
        const skillDesc = w.skills.length > 0 ? `｜技能(${w.skills.length})：${w.skills.join(', ')}` : '';
        const who = w.name ? `${w.name}（${w.title}）` : w.title;
        const vibe = w.personality ? `｜性格：${w.personality.slice(0, 40)}${w.personality.length > 40 ? '…' : ''}` : '';
        lines.push(`- ${who} (\`${w.id}\`)：${w.role || '（无定位描述）'}${vibe}${skillDesc}｜${toolDesc}`);
      }
      lines.push('', '用 get_worker(<id>) 获取某位员工的完整资料（含名字/性格）；或用 spawn_worker(worker: "<id>") 一键创建。');
      return lines.join('\n');
    } catch (err: any) {
      return `读取员工库失败: ${err.message}`;
    }
  },
});

// ═════════════════════════════════════════════════════
// get_worker — 读取单个员工完整资料
// ═════════════════════════════════════════════════════

tools['get_worker'] = tool({
  description: `读取指定预制员工的完整资料（名字、性格、角色定位、适用场景、systemPrompt 模板、推荐工具组）。返回的 systemPrompt 可直接用于 spawn_agent，tools 是 JSON 数组可直接复制给 tools 参数。`,
  inputSchema: z.object({
    id: z.string().describe('员工 id（如 code-implementer / researcher，用 list_workers 查看全部）'),
  }),
  execute: async ({ id }): Promise<string> => {
    try {
      const dir = await resolveWorkersDir();
      const file = path.join(dir, `${id}.md`);
      const content = await fs.readFile(file, 'utf-8');
      const w = parseWorker(content);

      const lines: string[] = [];
      const who = w.name ? `${w.name}（${w.title}）` : w.title;
      lines.push(`员工：${who} (\`${w.id}\`)`);
      if (w.personality) lines.push(`\n【性格】\n${w.personality}`);
      if (w.role) lines.push(`\n【角色定位】\n${w.role}`);
      if (w.scenarios) lines.push(`\n【适用场景】\n${w.scenarios}`);
      const identity = buildIdentity(w);
      if (identity) {
        lines.push(`\n【创建时注入的身份段（spawn_worker 自动拼接到 systemPrompt 前）】\n${identity}`);
      }
      if (w.systemPrompt) {
        lines.push(`\n【systemPrompt（spawn_agent 的 systemPrompt 参数，可直接复制）】\n${w.systemPrompt}`);
      }
      if (w.tools.length > 0) {
        lines.push(`\n【推荐工具组（spawn_agent 的 tools 参数，JSON 数组）】\n${JSON.stringify(w.tools)}`);
      } else {
        lines.push('\n【推荐工具组】未配置');
      }
      if (w.skills.length > 0) {
        lines.push(`\n【默认解锁技能（spawn_worker 自动加载）】\n${JSON.stringify(w.skills)}`);
      }
      lines.push('\n快速路径：spawn_worker(worker: "' + id + '", name: "<唯一名，省略时用员工默认名字>", contextAndTask: "<任务背景>", skills: ["<额外技能名>"])');
      return lines.join('\n');
    } catch (err: any) {
      return `未找到员工 "${id}"。可用 list_workers 查看全部员工 id。(${err.message})`;
    }
  },
});

// ═════════════════════════════════════════════════════
// spawn_worker — 从预制员工库创建 mission 子模型（身份 + 提示词与工具组自动装配）
// ═════════════════════════════════════════════════════

tools['spawn_worker'] = tool({
  description: `从预制员工库创建子模型（固定 mission 模式）。只传员工 id，systemPrompt 模板、推荐工具组与身份（名字+性格）自动从员工库装配，无需手动编写。name 可省略，省略时用员工的默认名字。支持 skills 参数传入技能名数组，自动解锁该技能的所有工具并在提示词中注入使用说明。创建后仍需 agent_task 派活。`,
  inputSchema: z.object({
    worker: z.string().describe('预制员工 id（如 code-implementer / researcher，用 list_workers 查看全部）'),
    name: z.string().optional().describe('(可选) 子模型的唯一名称，省略时用员工的默认名字（如小码）；同名已存在会重新创建'),
    contextAndTask: z.string().optional().describe('(可选) 传给子模型的任务背景/额外上下文，会在派活前注入'),
    skills: z.array(z.string()).optional().describe('(可选) 要解锁的技能名列表，如 ["browser-control", "web-accessor"]；技能的所有工具会自动加入并注入对应使用说明'),
  }),
  execute: async ({ worker, name, contextAndTask, skills }): Promise<string> => {
    // 读取预制员工
    let w: ParsedWorker;
    try {
      const dir = await resolveWorkersDir();
      const content = await fs.readFile(path.join(dir, `${worker}.md`), 'utf-8');
      w = parseWorker(content);
    } catch (err: any) {
      return `❌ 未找到预制员工 "${worker}"。可用 list_workers 查看全部员工 id。(${err.message})`;
    }

    // 校验员工模板完整性
    if (!w.systemPrompt) {
      return `❌ 员工 "${worker}" 未配置 systemPrompt 模板，无法创建。请检查 src/prompts/workers/${worker}.md 的 ----SYSTEM_PROMPT_START/END---- 标记。`;
    }
    if (w.tools.length === 0) {
      return `❌ 员工 "${worker}" 未配置推荐工具组，无法创建。请检查 ${worker}.md 的 ----TOOLS_START/END---- 标记。`;
    }

    // name 省略时用员工默认名字（昵称）；昵称也未配置则回退 id
    const agentName = name ?? (w.name || w.id);

    // 合并技能：员工默认技能 + 显式传入的技能（去重）
    const mergedSkillNames = [...(w.skills || [])];
    if (skills && skills.length > 0) {
      const skillSet = new Set(mergedSkillNames);
      for (const s of skills) {
        if (!skillSet.has(s)) {
          mergedSkillNames.push(s);
          skillSet.add(s);
        }
      }
    }

    // 解析技能详情，合并工具并生成技能描述段落
    let mergedTools = [...w.tools];
    let skillSection = '';
    if (mergedSkillNames.length > 0) {
      const details = await resolveSkillDetails(mergedSkillNames);
      const existingSet = new Set(mergedTools);
      for (const toolName of details.mergedTools) {
        if (!existingSet.has(toolName)) {
          mergedTools.push(toolName);
          existingSet.add(toolName);
        }
      }
      skillSection = details.skillSection;
    }

    // 身份段（名字 + 性格）拼接到 systemPrompt 前，技能说明拼接到 systemPrompt 后
    const identity = buildIdentity(w);
    const finalPrompt = identity
      ? `${identity}\n\n${w.systemPrompt}${skillSection}`
      : `${w.systemPrompt}${skillSection}`;

    // 固定 mission 模式创建
    subAgentManager.spawn({
      mode: 'mission',
      name: agentName,
      tools: mergedTools,
      systemPrompt: finalPrompt,
      context: contextAndTask,
    });

    const toolList = mergedTools.join(', ');
    const who = w.name ? `${w.name}（${w.title}）` : w.title;
    const identityDesc = identity ? identity.replace(/\n/g, ' ') : '（未配置）';
    // 展示信息：默认技能 + 额外技能
    const defaultSkillInfo = w.skills && w.skills.length > 0 ? `默认技能(${w.skills.length}): ${w.skills.join(', ')}` : '';
    const extraSkills = skills && skills.length > 0
      ? `额外技能(${skills.length}): ${skills.join(', ')}`
      : '';
    const skillInfo = [defaultSkillInfo, extraSkills].filter(Boolean).join(' | ');
    return `✅ 已从预制员工库创建 mission 子模型 "${agentName}"（${who}）\n身份：${identityDesc}\n可用工具(${mergedTools.length}): ${toolList}\n${skillInfo}\n\n下一步：调用 agent_task(name: "${agentName}", task: "<任务描述>") 派活；可用 agent_query 查状态、agent_fire 销毁。`;
  },
});

// ═════════════════════════════════════════════════════
// worker-library-prompt-get — 查看技能说明
// ═════════════════════════════════════════════════════

tools['worker-library-prompt-get'] = tool({
  description: `获取 worker-library 技能的详细说明文档（SKILL.md），包含预制员工库的使用说明。`,
  inputSchema: z.object({}),
  execute: async (): Promise<string> => {
    try {
      const skillPath = path.join(__dirname, 'SKILL.md');
      return await fs.readFile(skillPath, 'utf-8');
    } catch (error) {
      return `读取失败: ${(error as Error).message}`;
    }
  },
});

export default tools;


















