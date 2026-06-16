/**
 * ChatParticipant
 *
 * 使用 VS Code 1.98 的 `chat.createChatParticipant` API
 * 注册 seek-agent 为原生聊天参与者。
 *
 * 支持流式渲染：累积 token 后分批推送，连接取消信号。
 */

import * as vscode from 'vscode';
import { AgentClient } from './agentClient';

/** 推送间隔（ms） */
const FLUSH_INTERVAL = 80;
/** 单次推送最小字符数 */
const FLUSH_MIN_CHARS = 20;

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  client: AgentClient,
): vscode.ChatParticipant {
  const participant = vscode.chat.createChatParticipant(
    'seek.chat',
    async (request, chatContext, response, token) => {
      if (!client.isConnected) {
        response.markdown('⏳ Agent 未连接，请运行 `Seek AI: Ping agent` 启动...');
        return;
      }

      // ── 构造消息历史 ──
      const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];

      for (const turn of chatContext.history) {
        if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter((p): p is vscode.ChatResponseMarkdownPart =>
              p instanceof vscode.ChatResponseMarkdownPart,
            )
            .map(p => p.value.value)
            .join('');
          messages.push({ role: 'assistant', content: text });
        } else {
          messages.push({ role: 'user', content: (turn as any).prompt ?? '' });
        }
      }
      messages.push({ role: 'user', content: request.prompt });

      // ── 流式分批推送 ──
      let buffer = '';
      let flushTimer: ReturnType<typeof setInterval> | null = null;

      const flush = () => {
        if (buffer.length > 0 && !token.isCancellationRequested) {
          response.markdown(buffer);
          buffer = '';
        }
      };

      // 定时 flush
      flushTimer = setInterval(flush, FLUSH_INTERVAL);

      try {
        await client.requestChat(
          { messages },
          (chunk: string) => {
            buffer += chunk;
            // 积累到一定量时立即 push，减少延迟感
            if (buffer.length >= FLUSH_MIN_CHARS) {
              flush();
            }
          },
          token, // 传入 CancellationToken
        );

        // 最后一次 flush（收到 end 后）
        if (flushTimer) clearInterval(flushTimer);
        flush();
      } catch (err: any) {
        if (flushTimer) clearInterval(flushTimer);
        // 取消不显示错误
        if (err.message === 'Chat cancelled by user') return;
        // 超时
        if (err.message === 'Chat timeout') {
          flush();
          response.markdown('\n\n_⏰ 响应超时，请重试_');
          return;
        }
        // 其他错误
        flush();
        if (!token.isCancellationRequested) {
          response.markdown(`\n\n❌ 错误: ${err.message}`);
        }
      }
    },
  );

  participant.iconPath = new vscode.ThemeIcon('sparkle');
  context.subscriptions.push(participant);
  return participant;
}
