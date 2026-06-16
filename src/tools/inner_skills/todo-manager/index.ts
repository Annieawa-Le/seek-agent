/**
 * todo_manager skill 入口 — 持久化工具
 *
 * 提供四个持久化工具，用于在磁盘和会话内存之间传输 todo 数据。
 */
import { todoSave } from './todo-save';
import { todoLoad } from './todo-load';
import { todoListSaved } from './todo-list-saved';
import { todoDeleteSaved } from './todo-delete-saved';
import { todoManagerPromptGet } from './prompt-get';

const tools: Record<string, any> = {
  'todo_save': todoSave,
  'todo_load': todoLoad,
  'todo_list_saved': todoListSaved,
  'todo_delete_saved': todoDeleteSaved,
  'todo-manager-prompt-get': todoManagerPromptGet,
};

export default tools;
