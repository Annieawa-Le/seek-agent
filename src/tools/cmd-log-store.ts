/**
 * cmd-log-store.ts — 命令执行日志存储（execute_command 的"最近一次结果"落点）
 *
 * 每次 execute_command 运行后，把完整输出落盘到
 *   {workspace}/sessions/{sessionId}/latest-cmd.log
 * （覆盖式写入，只保留最近一次）。execute_command 返回给模型的文本被截断到
 * 10000 字符，超出部分可用 command_log 工具从该日志取回。
 *
 * 存储与 WorklogStore 对齐：按 sessionId 分区，agent 启动/切换会话时 setSessionId。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionsRoot } from '../workdir';

/** 落盘日志的字符上限（防止单条命令输出过大撑爆磁盘） */
export const CMD_LOG_MAX_CHARS = 500_000;

export interface CmdLogEntry {
  command: string;
  stdout: string;
  stderr: string;
  /** 退出码（deferred/未知时为 undefined） */
  exitCode?: number | null;
  /** 命令超时转入后台任务的标记 */
  deferred?: boolean;
  /** deferred 时的后台任务名 */
  taskName?: string;
  createdAt: string;
}

/** sessionId → 安全文件/文件夹名（非法字符替换为下划线） */
function safeName(id: string): string {
  return (id || 'default').replace(/[\\/:*?"<>|]/g, '_');
}

/** 拼接完整输出文本（stdout + stderr，与 execute_command 的 AI 文本语义一致） */
export function combineOutput(stdout: string, stderr: string): string {
  let out = stdout;
  if (stderr) out += (out ? '\n[stderr]: ' : '') + stderr;
  return out;
}

/** 生成日志文件文本：注释头（命令/退出码/时间）+ 完整输出 */
export function formatCmdLog(entry: CmdLogEntry): string {
  const exitText = entry.exitCode != null
    ? String(entry.exitCode)
    : entry.deferred
      ? `运行中（已转入后台任务 ${entry.taskName ?? '?'}）`
      : '未知';
  const head = [
    '# execute_command 最近一次运行结果',
    `# 命令: ${entry.command}`,
    `# 退出码: ${exitText}`,
    `# 时间: ${entry.createdAt}`,
    '# ' + '-'.repeat(48),
  ].join('\n');
  let body = combineOutput(entry.stdout, entry.stderr);
  if (body.length > CMD_LOG_MAX_CHARS) {
    body = body.slice(0, CMD_LOG_MAX_CHARS) + `\n…（日志已截断，原始输出共 ${body.length} 字符）`;
  }
  return `${head}\n${body}`;
}

class CmdLogStore {
  private sessionId = '';

  /** agent 启动/切换会话时调用，日志落点跟随会话切换 */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** 日志文件路径：sessions/{sessionId}/latest-cmd.log */
  get filePath(): string {
    return path.join(getSessionsRoot(), 'sessions', safeName(this.sessionId), 'latest-cmd.log');
  }

  /** 覆盖式写入最近一次命令结果（失败静默，不影响主流程） */
  save(entry: CmdLogEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, formatCmdLog(entry), 'utf-8');
    } catch {
      // 落盘失败不影响命令返回
    }
  }

  /** 读取日志全文（不存在或读取失败返回 null） */
  read(): string | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      return fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return null;
    }
  }
}

/** 全局单例（Electron 每会话一个 agent 进程，进程内单例安全） */
export const cmdLogStore = new CmdLogStore();
