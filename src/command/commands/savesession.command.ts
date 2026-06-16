import { Command } from '../types';
import path from 'node:path';
import fs from 'node:fs';
import { getWorkspaceRoot } from '../../workdir';

/** 会话保存目录（基于工作区根目录） */
function getSessionDir(): string {
  const dir = path.join(getWorkspaceRoot(), 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export const SaveSessionCommand: Command = {
  name: 'savesession',
  aliases: ['/savesession', '/save'],
  description: '保存当前对话会话到文件',
  usage: '/savesession [name]',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t === '/savesession' || t.startsWith('/savesession ') ||
           t === 'savesession' || t.startsWith('savesession ') ||
           t === '/save' || t.startsWith('/save ');
  },
  execute(input: string, ctx): void {
    const trimmed = input.trim();
    const nameMatch = trimmed.match(/^\/(?:savesession|save)\s+(.+)/)
      || trimmed.match(/^savesession\s+(.+)/);

    let fileName: string;
    if (nameMatch) {
      // 用名字中的非法文件名字符替换为下划线
      fileName = nameMatch[1].trim().replace(/[\\/:*?"<>|]/g, '_') + '.json';
    } else {
      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fileName = `session-${ts}.json`;
    }

    const filePath = path.join(getSessionDir(), fileName);
    const messages = ctx.agent.getMessages();

    if (messages.length === 0) {
      ctx.ui.addUserMessage(input);
      ctx.ui.addAgentMessage('⚠ 当前没有对话消息可保存。');
      return;
    }

    const data = {
      version: 1,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      agentMessages: messages,
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    ctx.ui.addUserMessage(input);
    ctx.ui.addAgentMessage(
      `✅ 对话已保存（${messages.length} 条消息）\n   \`${path.relative(getWorkspaceRoot(), filePath)}\``
    );
  },
};
