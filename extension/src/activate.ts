/**
 * Seek AI IDE - VS Code 扩展入口
 *
 * 职责：
 * 1. 启动 agent 子进程
 * 2. 建立 JSON-RPC 连接
 * 3. 注册 InlineCompletionProvider 和 ChatParticipant
 * 4. 注册调试命令
 */

import * as vscode from 'vscode';
import { startAgentProcess, stopAgentProcess, restartAgentProcess } from './agentProcess';
import { AgentClient } from './agentClient';
import { SeekCompletionProvider } from './completionProvider';
import { registerChatParticipant } from './chatParticipant';
import { SeekCodeActionProvider } from './codeActionProvider';

let agentClient: AgentClient | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;

// ── 激活 ──

export function activate(context: vscode.ExtensionContext): void {
  console.error('[seek] activating Seek AI IDE...');

  // 1. 创建 agent 客户端
  agentClient = new AgentClient();
  context.subscriptions.push(agentClient);

  // 2. 启动 agent 进程并连接
  try {
    const child = startAgentProcess(context);
    agentClient.connect(child);
    console.error('[seek] agent process started and connected');
  } catch (err) {
    console.error('[seek] failed to start agent:', err);
  }

  // 3. 注册内联补全
  const completionProvider = new SeekCompletionProvider(agentClient);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      completionProvider,
    ),
  );

  // 3b. 注册 CodeActionProvider（灯泡菜单）
  const codeActionProvider = new SeekCodeActionProvider(agentClient);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**' },
      codeActionProvider,
      { providedCodeActionKinds: SeekCodeActionProvider.providedCodeActionKinds }
    ),
  );
  console.error('[seek] code action provider registered');

  // 4. 注册聊天参与者
  try {
    registerChatParticipant(context, agentClient);
    console.error('[seek] chat participant registered');
  } catch (err) {
    console.error('[seek] failed to register chat participant:', err);
  }

  // 5. 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('seek.ping', async () => {
      if (!agentClient?.isConnected) {
        vscode.window.showErrorMessage('Seek AI: agent 未连接');
        return;
      }
      try {
        const result = await agentClient.ping();
        vscode.window.showInformationMessage(`Seek AI: pong! (${result.timestamp})`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Seek AI: ping 失败 — ${err.message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('seek.restart', async () => {
      try {
        const child = restartAgentProcess(context);
        agentClient?.connect(child);
        vscode.window.showInformationMessage('Seek AI: agent 已重启');
      } catch (err: any) {
        vscode.window.showErrorMessage(`Seek AI: 重启失败 — ${err.message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('seek.status', async () => {
      const connected = agentClient?.isConnected ?? false;
      vscode.window.showInformationMessage(`Seek AI: ${connected ? '✅ 已连接' : '❌ 未连接'}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('seek.diagnose', async () => {
      const output = vscode.window.createOutputChannel('Seek AI');
      output.clear();
      output.appendLine('=== Seek AI IDE 诊断 ===\n');

      const proc = (await import('./agentProcess')).getAgentProcess();
      output.appendLine(`[进程] agent 进程: ${proc ? '运行中 (pid=' + proc.pid + ')' : '❌ 未运行'}`);
      output.appendLine(`[连接] JSON-RPC: ${agentClient?.isConnected ? '✅ 已连接' : '❌ 未连接'}`);

      if (agentClient?.isConnected) {
        try {
          const pingResult = await agentClient.ping();
          output.appendLine(`[通信] ping: ✅ (延迟 ${Date.now() - pingResult.timestamp}ms)`);
          const echoResult = await agentClient.echo('hello');
          output.appendLine(`[通信] echo: ✅ (${echoResult.text})`);
        } catch (err: any) {
          output.appendLine(`[通信] ❌ 错误: ${err.message}`);
        }
      }

      const config = vscode.workspace.getConfiguration('seek');
      output.appendLine(`[配置] model: ${config.get('model')}`);
      output.appendLine(`[配置] agentPath: ${config.get('agentPath') || '(bundled)'}\n`);
      output.appendLine('=== 诊断完成 ===');
      output.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('seek.explainCode', async (explanation: string) => {
      const channel = vscode.window.createOutputChannel('Seek AI 解释');
      channel.clear();
      channel.appendLine('=== AI 代码解释 ===');
      channel.appendLine('');
      channel.append(explanation);
      channel.show();
    }),
  );

  // 6. 状态栏
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(sparkle) Seek';
  statusBarItem.command = 'seek.status';
  statusBarItem.tooltip = 'Seek AI IDE 状态';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  console.error('[seek] activation complete');
}

// ── 停用 ──

export function deactivate(): void {
  console.error('[seek] deactivating...');
  stopAgentProcess();
  agentClient?.dispose();
  agentClient = null;
  statusBarItem?.dispose();
  statusBarItem = null;
}

