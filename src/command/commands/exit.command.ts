import { Command } from '../types';


export const ExitCommand: Command = {
  name: 'exit',
  aliases: ['/exit'],
  description: '退出程序',
  usage: '/exit',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t === '/exit' || t === 'exit';
  },
  execute(_input: string, ctx): void {
    ctx.ui.stop();
    process.exit(0);
  },
};

