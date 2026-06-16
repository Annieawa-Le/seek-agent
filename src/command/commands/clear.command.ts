import { Command } from '../types';


export const ClearCommand: Command = {
  name: 'clear',
  aliases: ['/clear'],
  description: '清空消息区域',
  usage: '/clear',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t === '/clear' || t === 'clear';
  },
  execute(_input: string, ctx): void {
    ctx.ui.clearMessages();
  },
};

