import { Command } from '../types';

import { CommandRegistry } from '../registry';

/**
 * 帮助指令需要访问已注册的指令列表，因此通过工厂函数创建。
 */
export function createHelpCommand(registry: CommandRegistry): Command {
  return {
    name: 'help',
    aliases: ['/help', '/h'],
    description: '显示所有可用指令',
    usage: '/help',
    match(input: string): boolean {
      const t = input.trim().toLowerCase();
      return t === '/help' || t === 'help' || t === '/h';
    },
    execute(_input: string, ctx): void {
      const cmds = registry.getCommands();
      let msg = '**可用指令:**\n\n';
      for (const cmd of cmds) {
        const usage = cmd.usage || `/${cmd.name}`;
        const aliasHint = cmd.aliases?.length
          ? ` (${cmd.aliases.join(', ')})`
          : '';
        msg += `- \`${usage}\`${aliasHint}  — ${cmd.description}\n`;
      }
      ctx.ui.addUserMessage('/help');
      ctx.ui.addAgentMessage(msg);
    },
  };
}

