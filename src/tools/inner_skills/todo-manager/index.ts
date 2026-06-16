/**
 * todo_manager skill 入口 — 持久化工具
 *
 * 提供四个持久化工具，用于在磁盘和会话内存之间传输 todo 数据。
 */
import { todoSave } from './scripts/todo-save';
import { todoLoad } from './scripts/todo-load';
import { todoListSaved } from './scripts/todo-list-saved';
import { todoDeleteSaved } from './scripts/todo-delete-saved';
import { todoManagerPromptGet } from './scripts/prompt-get';

const tools: Record<string, any> = {
  'todo_save': todoSave,
  'todo_load': todoLoad,
  'todo_list_saved': todoListSaved,
  'todo_delete_saved': todoDeleteSaved,
  'todo-manager-prompt-get': todoManagerPromptGet,
};

export default tools;
