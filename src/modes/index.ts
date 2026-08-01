import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMode } from './registry';
import { buildKbPreProcess } from './preprocess';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 读取 prompts/addon/ 下的模式行为准则（读不到时返回 undefined） */
function readAddon(name: string): string | undefined {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'prompts', 'addon', name), 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * 注册所有内置模式（幂等，可重复调用）。
 * - kb（知识库模式）：P1 完整实现
 * - manager / worker：在 P2 / P2.5 补充行为（此处仅注册 meta，供 /mode list 展示）
 */
export function registerBuiltinModes(): void {
  registerMode({
    name: 'kb',
    label: '知识库模式',
    description: '回答前强制检索工作记忆 + 长期记忆 + 知识库，降低幻觉',
    icon: '📚',
    promptAddon: readAddon('KB.md'),
    preProcess: buildKbPreProcess(5),
  });

  registerMode({
    name: 'manager',
    label: 'Manager 模式',
    description: '子 agent 编排，复杂任务并行',
    icon: '🧑‍💼',
    mainReplacement: readAddon('MANAGER.md'), // 角色模式：替换 MAIN.md 成为主提示词
  });

  registerMode({
    name: 'worker',
    label: '打工人模式',
    description: '跨会话执行者，接受协作派活',
    icon: '🧑‍🔧',
    mainReplacement: readAddon('WORKER.md'), // 角色模式：替换 MAIN.md 成为主提示词
  });
}







