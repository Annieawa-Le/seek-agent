import { Command } from '../types';
import {
  listModes,
  setActiveModes,
  addActiveMode,
  removeActiveMode,
  getActiveModeNames,
  describeActive,
} from '../../modes/registry';

/**
 * /mode — 查看/切换 Agent 模式
 *
 * 用法：
 *   /mode            查看当前模式
 *   /mode list       列出所有已注册模式
 *   /mode <name>     切换为指定模式（default 退出模式）
 *   /mode +<name>    叠加启用一个模式
 *   /mode -<name>    移除一个叠加的模式
 */
export const ModeCommand: Command = {
  name: 'mode',
  aliases: ['/mode'],
  description: '查看/切换 Agent 模式（kb / manager / worker / default）',
  usage: '/mode [list | <name> | +<name> | -<name>]',
  match(input: string): boolean {
    const t = input.trim().toLowerCase();
    return t === '/mode' || t === 'mode' || t.startsWith('/mode ') || t.startsWith('mode ');
  },
  execute(input: string, ctx): void {
    const args = input.trim().replace(/^\/?mode\s*/i, '').trim();

    // ── 无参数：显示当前模式 ──
    if (!args) {
      ctx.ui.addAgentMessage(describeActive());
      ctx.ui.addAgentMessage('可用模式：/mode list 查看全部；/mode <name> 切换');
      return;
    }

    // ── list：列出所有已注册模式 ──
    if (args === 'list' || args === 'ls') {
      const modes = listModes();
      const active = getActiveModeNames();
      const lines = modes.map((m) => {
        const mark = active.includes(m.name) ? '● ' : '○ ';
        return `${mark}${m.icon ?? ''}${m.name}（${m.label}）— ${m.description}`;
      });
      const linesAll = [
        describeActive(),
        '',
        '已注册模式：',
        ...lines,
        active.length === 0 ? '  ○ default（快速模式）— 无策略挂载' : '',
        '',
        '用法：/mode <name> 切换（default 退出）| /mode +<name> 叠加 | /mode -<name> 移除',
      ].filter(Boolean);
      ctx.ui.addAgentMessage(linesAll.join('\n'));
      return;
    }

    // ── +name / -name / name ──
    let result: { ok: boolean; message: string };
    if (args.startsWith('+')) {
      result = addActiveMode(args.slice(1));
    } else if (args.startsWith('-')) {
      result = removeActiveMode(args.slice(1));
    } else {
      result = setActiveModes([args]);
    }

    if (result.ok) {
      // 切换后刷新 system prompt，让模式 promptAddon 生效
      ctx.agent.reloadPrompt();
      ctx.ui.addAgentMessage(result.message);
    } else {
      ctx.ui.addAgentMessage(`❌ ${result.message}`);
    }
  },
};
