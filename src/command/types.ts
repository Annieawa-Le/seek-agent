import { TerminalUI } from '../ui';
import type { CLIAAgent } from '../agent';

/**
 * 指令上下文 —— execute 时传入，携带运行时所需的所有依赖。
 * 当前有 ui（终端渲染）和 agent（会话存取），后续扩展可直接加字段。
 */
export interface CommandContext {
  ui: TerminalUI;
  agent: CLIAAgent;
}

/**
 * 指令接口 —— 每个指令只需要 match + execute 两个关注点。
 * match 判断是否该由自己处理，execute 执行逻辑。
 */
export interface Command {
  /** 指令主名称（用于帮助列表） */
  name: string;
  /** 别名（如 '/exit', 'exit'） */
  aliases?: string[];
  /** 简短说明 */
  description: string;
  /** 用法示例 */
  usage?: string;
  /** 判断输入是否匹配该指令 */
  match(input: string): boolean;
  /** 执行指令逻辑。确保 match() 返回 true 后才调用。 */
  execute(input: string, ctx: CommandContext): void | Promise<void>;
}
