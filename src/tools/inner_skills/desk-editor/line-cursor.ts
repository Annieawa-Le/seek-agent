import { tool } from 'ai';
import { z } from 'zod';
import { deskEditManager } from '../../desk-edit';

export const lineCursor = tool({
  description: [
    '编辑模式下的光标操作工具。有 move 和 selectto 两种动作：',
    '',
    '- move: 将光标移动到 target 行前（位置 target.5）。清除已有选中。',
    '  target=0 → 第 1 行前；target=文件行数 → 文件末尾',
    '',
    '- selectto: 直接指定起始行号和终止行号进行选择（均 1-based）。',
    '  例：selectto(start=3, end=8) 选中行 3-8，光标移到 8.5。',
    '',
    '渲染标记说明：',
    '  ^  光标在此行前',
    '  v  光标在此行后（上一行标记）',
    '  >  此行被选中',
    '',
    '调用 move 会清除 selectto 的选中状态。',
  ].join('\n'),
  inputSchema: z.object({
    id: z.string().describe('编辑会话 ID'),
    action: z.enum(['move', 'selectto']),
    target: z.number().int().optional().describe('move 的目标行号（0-based 行间位置）'),
    start: z.number().int().optional().describe('selectto 起始行号（1-based）'),
    end: z.number().int().optional().describe('selectto 终止行号（1-based）'),
  }).refine(data => {
    if (data.action === 'move') return data.target !== undefined;
    if (data.action === 'selectto') return data.start !== undefined && data.end !== undefined;
    return false;
  }, { message: '参数不匹配 action 类型' }),
  execute: async ({ id, action, target, start, end }) => {
    const tid = id?.trim();
    if (!deskEditManager.isActive()) return '❌ 未处于编辑模式，请先调用 desk_edit';
    if (action === 'move') {
      const { result } = deskEditManager.moveCursor(tid, target!);
      return result;
    } else {
      const { result } = deskEditManager.selectTo(tid, start!, end!);
      return result;
    }
  },
});
