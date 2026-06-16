/**
 * Agent 子进程管理
 *
 * 负责 spawn/restart/kill seek-agent 运行时进程。
 */

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

let _child: ChildProcess | null = null;

/**
 * 启动 agent 子进程。
 * 优先使用配置的路径，否则使用 bundled agent-runtime。
 */
export function startAgentProcess(context: vscode.ExtensionContext): ChildProcess {
  if (_child) {
    return _child;
  }

  const configPath = vscode.workspace.getConfiguration('seek').get<string>('agentPath');

  let scriptPath: string;
  // cwd 设为 monorepo 根目录
  const projectRoot = path.resolve(context.extensionUri.fsPath, '..');

  if (configPath && configPath.length > 0) {
    scriptPath = configPath;
  } else {
    // 使用 monorepo 中的 agent-runtime
    scriptPath = path.join(projectRoot, 'packages', 'agent-runtime', 'dist', 'index.js');
  }

  console.error('[seek] spawning agent:', scriptPath);

  const child = spawn('node', [scriptPath], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  child.stdout?.on('data', (data: Buffer) => {
    // JSON-RPC 走 stdout，由 vscode-jsonrpc 处理
  });

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) {
      console.error('[agent]', msg);
    }
  });

  child.on('exit', (code) => {
    console.error(`[seek] agent exited with code ${code}`);
    _child = null;
  });

  child.on('error', (err) => {
    console.error('[seek] agent error:', err);
    _child = null;
  });

  _child = child;
  return child;
}

/** 停止 agent 子进程 */
export function stopAgentProcess(): void {
  if (_child) {
    _child.kill('SIGTERM');
    _child = null;
  }
}

/** 重启 agent 子进程 */
export function restartAgentProcess(context: vscode.ExtensionContext): ChildProcess {
  stopAgentProcess();
  return startAgentProcess(context);
}

/** 获取当前 agent 子进程 */
export function getAgentProcess(): ChildProcess | null {
  return _child;
}


