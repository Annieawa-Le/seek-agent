/**
 * panel.ts — sub-agent TUI 右栏面板
 *
 * 在 TUI 右侧面板中显示所有子 agent 的状态列表。
 * 格式：名称 | 模式 | 状态
 */

import { subAgentManager } from './manager';
import { formatPanelLine, panelHeader, panelFooter, panelEmptyLine } from '../../panel-registry';

// 与 panel-registry.ts 一致的背景保持重置
const RESET_BG = '\x1b[0m\x1b[38;2;0;0;0;48;2;245;245;245m';
const DIM = '\x1b[2m';

export default function renderPanel(pw: number): string[] {
  const agents = subAgentManager.getAll();
  if (agents.length === 0) return []; // 无子 agent 时隐藏

  const lines: string[] = [];

  // 子标题框
  lines.push(panelHeader(pw, ' 子模型 '));
  lines.push(panelEmptyLine(pw));

  for (const agent of agents) {
    // 状态图标
    let statusIcon: string;
    let statusColor: string;
    switch (agent.status) {
      case 'running':
        statusIcon = '●';
        statusColor = '\x1b[32m'; // 绿色
        break;
      case 'done':
        statusIcon = '✓';
        statusColor = '\x1b[36m'; // 青色
        break;
      case 'error':
        statusIcon = '✗';
        statusColor = '\x1b[31m'; // 红色
        break;
      default:
        statusIcon = '○';
        statusColor = '\x1b[90m'; // 灰色
    }

    // 模式标签
    let modeLabel: string;
    switch (agent.mode) {
      case 'clone':   modeLabel = '克隆'; break;
    // 模式标签
    let modeLabel: string;
    switch (agent.mode) {
      case 'clone':   modeLabel = '克隆'; break;
      case 'mission': modeLabel = '任务'; break;
      default:        modeLabel = agent.mode;
    }
    const nameStr = `${statusColor}${statusIcon}${RESET_BG} ${agent.name}`;
    const modeStr = `${DIM}${modeLabel}${RESET_BG}`;
    const statusStr = `${DIM}${statusIcon === '●' ? '运行中' : statusIcon === '✓' ? '已完成' : statusIcon === '✗' ? '出错' : '空闲'}${RESET_BG}`;

    lines.push(formatPanelLine(pw, `${nameStr}  ${modeStr}  ${statusStr}`));
  }

  lines.push(panelEmptyLine(pw));
  lines.push(panelFooter(pw));

  return lines;
}

