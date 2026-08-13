import { Command } from '../types';
import path from 'node:path';
import { getSessionsRoot } from '../../workdir';

/**
 * /savesession — 把当前会话保存到 sessions/{sessionId}/ 文件夹
 * （session.json 主会话 + payload.json payload 历史，落点固定为稳定 sessionId）。
 * 旧版的 [name] 参数不再参与命名：文件夹名 = sessionId，避免标题/名字漂移。
 */
export const SaveSessionCommand: Command = {
  name: 'savesession',
  aliases: ['/savesession', '/save'],
  description: '保存当前对话会话到文件（sessions/{sessionId}/ 文件夹）',
  usage: '/savesession',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t === '/savesession' || t.startsWith('/savesession ') ||
           t === 'savesession' || t.startsWith('savesession ') ||
           t === '/save' || t.startsWith('/save ');
  },
  execute(input: string, ctx): void {
    ctx.ui.addUserMessage(input);
    const messages = ctx.agent.getMessages();

    if (messages.length === 0) {
      ctx.ui.addAgentMessage('⚠ 当前没有对话消息可保存。');
      return;
    }

    const dir = ctx.agent.saveSessionToDisk();
    if (dir) {
      ctx.ui.addAgentMessage(
        `✅ 对话已保存（${messages.length} 条消息）\n   \`${path.relative(getSessionsRoot(), dir)}\``
      );
    } else {
      ctx.ui.addAgentMessage('❌ 保存失败。');
    }
  },
};


