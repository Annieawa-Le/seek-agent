/**
 * command — 可扩展的终端指令系统
 *
 * 使用方式：
 *   const registry = createCommandRegistry();
 *   const handled = await registry.tryExecute(input, { ui, agent });
 *   if (!handled) { /* 交给 agent * / }
 */

export { CommandRegistry } from './registry';
export type { Command, CommandContext } from './types';
import { WithdrawCommand } from './commands/withdraw.command';

import { CommandRegistry } from './registry';
import { ExitCommand } from './commands/exit.command';
import { ClearCommand } from './commands/clear.command';
import { WorkdirCommand } from './commands/workdir.command';
import { WorkdirGlobalCommand } from './commands/workdir-global.command';
import { createHelpCommand } from './commands/help.command';
import { SaveSessionCommand } from './commands/savesession.command';
import { LoadSessionCommand } from './commands/loadsession.command';

/**
 * 创建并注册所有内置指令。
 * 如需注册额外指令，在返回的 registry 上继续 .register(yourCmd) 即可。
 */
export function createCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  registry
    .register(ExitCommand)
    .register(ClearCommand)
    .register(WithdrawCommand)
    .register(WorkdirCommand)
    .register(WorkdirGlobalCommand)
    // help 依赖 registry，放在最后注册
    .register(createHelpCommand(registry))
    .register(SaveSessionCommand)
    .register(LoadSessionCommand);

  return registry;
}



