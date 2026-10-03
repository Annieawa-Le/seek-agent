/**
 * alarm.ts — 闹钟工具
 *
 * 主模型需要长时间等待（等命令跑完、轮询外部状态、等子任务完成）时，
 * 用 alarm_set 设定闹钟：立即返回"设定成功"不阻塞，后台 setTimeout 计时。
 * 到点后通过 alarmListener（CLIAAgent 注册）把 "[闹钟]XX计时器已归零！"
 * 作为 user 消息注入 inputQueue 并驱动新一轮，打断当前处理（与子 agent
 * 提交注入同机制：空闲时 run 启动新一轮，处理中则消息在循环顶部插队消费）。
 */
import { tool } from 'ai';
import { z } from 'zod';
import { ToolOutput } from './tool-output';
import type { AlarmBulk } from './raw-bulk-types';

/** 闹钟到点注入回调（CLIAAgent 注册：把消息提交给 run()） */
let alarmListener: ((msg: string) => void) | null = null;
export function setAlarmListener(fn: ((msg: string) => void) | null): void {
  alarmListener = fn;
}

interface Alarm {
  label: string;
  durationMs: number;
  deadline: number;
  timer: NodeJS.Timeout;
}

class AlarmManager {
  private alarms = new Map<string, Alarm>();

  /** 设定闹钟；同 label 重复设定会取消前一个（覆盖语义） */
  set(label: string, durationMs: number): void {
    this.cancel(label);
    const deadline = Date.now() + durationMs;
    const timer = setTimeout(() => this.fire(label), durationMs);
    this.alarms.set(label, { label, durationMs, deadline, timer });
  }

  /** 取消闹钟；返回是否取消成功（未找到/已到点返回 false） */
  cancel(label: string): boolean {
    const alarm = this.alarms.get(label);
    if (!alarm) return false;
    clearTimeout(alarm.timer);
    this.alarms.delete(label);
    return true;
  }

  /** 所有未到点的闹钟（label + 剩余毫秒） */
  list(): Array<{ label: string; remainingMs: number }> {
    return [...this.alarms.values()].map(a => ({
      label: a.label,
      remainingMs: Math.max(0, a.deadline - Date.now()),
    }));
  }

  private fire(label: string): void {
    if (!this.alarms.delete(label)) return; // 已被取消
    alarmListener?.(`[闹钟]${label}计时器已归零！`);
  }
}

export const alarmManager = new AlarmManager();

// ── 工具 ──

export const alarmSetTool = tool({
  description: [
    '设定一个闹钟：在指定时长后自动注入一条 "[闹钟]XX计时器已归零！" 的 user 消息，',
    '打断当前处理并驱动新一轮（类似子 agent 提交的注入机制）。',
    '适合需要长时间等待（等命令执行完、轮询外部状态、等子任务返回）的场景：',
    '设定后立即返回"闹钟设定成功"，不阻塞当前工作，到点自动提醒。',
    '同 label 重复设定会覆盖前一个闹钟。',
  ].join(' '),
  inputSchema: z.object({
    duration: z.number().positive().describe('等待时长（秒），可带小数；到点后注入闹钟消息'),
    label: z.string().optional().describe('闹钟名称（注入消息中的 XX，用于区分多个闹钟），默认"等待"'),
  }),
  execute: async ({ duration, label }) => {
    const lbl = label?.trim() || '等待';
    alarmManager.set(lbl, duration * 1000);
    const at = new Date(Date.now() + duration * 1000).toLocaleTimeString();
    const bulk: AlarmBulk = { type: 'alarm', action: 'set', label: lbl, durationSec: duration, fireAt: at };
    return new ToolOutput(
      bulk,
      `⏰ 闹钟设定成功：${duration} 秒后（${at}）注入 "[闹钟]${lbl}计时器已归零！"。期间可继续其他工作，到点自动打断提醒；若提前完成可用 alarm_cancel(label="${lbl}") 取消。`
    );
  },
});

export const alarmCancelTool = tool({
  description: '取消一个尚未到点的闹钟（alarm_set 设定后提前完成时使用）。',
  inputSchema: z.object({
    label: z.string().describe('要取消的闹钟名称（alarm_set 时设定的 label）'),
  }),
  execute: async ({ label }) => {
    const ok = alarmManager.cancel(label);
    const bulk: AlarmBulk = { type: 'alarm', action: 'cancel', label, ok };
    return new ToolOutput(
      bulk,
      ok
        ? `✅ 已取消闹钟 "${label}"。`
        : `⚠ 未找到闹钟 "${label}"（可能已到点或从未设定）。`
    );
  },
});

export const alarmListTool = tool({
  description: '列出所有尚未到点的闹钟（label + 剩余时间）。',
  inputSchema: z.object({}),
  execute: async () => {
    const all = alarmManager.list();
    const bulk: AlarmBulk = { type: 'alarm', action: 'list', alarms: all };
    if (all.length === 0) return new ToolOutput(bulk, '📭 当前没有任何未到点的闹钟。');
    const lines = all.map((a, i) => {
      const sec = (a.remainingMs / 1000).toFixed(1);
      return `${i + 1}. ${a.label}（还剩 ${sec} 秒）`;
    });
    return new ToolOutput(bulk, `⏰ 未到点的闹钟（${all.length} 个）：\n${lines.join('\n')}`);
  },
});
