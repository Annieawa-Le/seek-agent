import { registerPanelProvider } from '../tools/panel-registry';
import { getActiveModes, listModes } from './registry';
import { subAgentManager } from '../tools/inner_skills/sub-agent/manager';
/**
 * 模式状态面板（TUI 右栏）。
 * 显示当前激活模式 + 已注册模式概览。Electron 的 RightPanel 另行实现。
 */
export function registerModeStatusPanel(): void {
  registerPanelProvider({
    id: 'modes',
    priority: -10, // 放在其他技能面板之后
    render: (pw: number) => {
      void pw;
      const active = getActiveModes();
      const all = listModes();
      const lines: string[] = [];
      lines.push('── 模式 ──');
      lines.push('');
      if (active.length === 0) {
        lines.push('⚡ 快速模式');
        lines.push('  （无策略挂载）');
      } else {
        for (const m of active) {
          lines.push(`${m.icon ?? '●'} ${m.label}`);
        }
      }
      lines.push('');
      lines.push(`已注册 ${all.length} 个模式`);
      return lines;
    },
  });
}


/**
 * Agent Dashboard：显示子 agent 状态（Manager 模式配套）。
 * 实时读取 subAgentManager，展示各子 agent 的名称/模式/状态/提交情况。
 */
export function registerManagerDashboard(): void {
  registerPanelProvider({
    id: 'manager-dashboard',
    priority: -9,
    render: () => {
      const agents = subAgentManager.getAll();
      const lines: string[] = [];
      lines.push('── 子 Agent ──');
      lines.push('');
      if (agents.length === 0) {
        lines.push('（暂无子 agent）');
      } else {
        for (const a of agents) {
          const statusIcon =
            a.status === 'running' ? '🔄' :
            a.status === 'done' ? '✅' :
            a.status === 'error' ? '❌' : '⏸';
          lines.push(`${statusIcon} ${a.name} [${a.mode}]`);
          lines.push(`  ${a.status}${a.submission ? ' · 已提交' : ''}`);
        }
      }
      return lines;
    },
  });
}


