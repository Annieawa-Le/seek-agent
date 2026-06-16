import { tool } from 'ai';
import { z } from 'zod';
import { deskEditManager } from '../../desk-edit';

export const linePaste = tool({
  description: [
    '编辑模式下的粘贴工具。统一替代 add/del/modify 操作：',
    '',
    '- 有选中行时：将选中的行替换为 lines 内容。lines 为空数组则删除选中行。',
    '- 无选中行时：在光标位置插入 lines 内容。',
    '',
    '操作后选中状态和光标均被清除，需先调用 line_cursor move 才能继续编辑。',
  ].join('\n'),
  inputSchema: z.object({
    id: z.string().describe('编辑会话 ID'),
    lines: z.array(z.string()).describe('要粘贴的内容行列表（空数组=删除选中）'),
  }),
  execute: async ({ id, lines }) => {
    const tid = id?.trim();
    if (!deskEditManager.isActive()) return '❌ 未处于编辑模式，请先调用 desk_edit';
    const { result } = deskEditManager.paste(tid, lines);
    return result;
  },
});
