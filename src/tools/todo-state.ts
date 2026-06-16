/**
 * todo-state.ts — 会话级共享内存状态
 *
 * 存放当前会话中所有 todo 数据，同时被 todo.ts（核心工具）和
 * todo-manager skill（持久化工具）引用。重启/重载后数据自然消失。
 */

import type { Todo } from './inner_skills/todo-manager/data';

// ── 模块级内存状态（仅当前会话有效） ──
let _todos: Todo[] = [];

/** 获取当前会话中的所有 todo（返回的是引用，修改会影响原数组） */
export function getTodos(): Todo[] {
  return _todos;
}

/** 整体替换当前会话中的所有 todo */
export function setTodos(todos: Todo[]): void {
  _todos = todos;
}

/** 清空当前会话 */
export function clearTodos(): void {
  _todos = [];
}

// ── 活跃 todo ──
let _activeTodo: string | null = null;

/** 获取当前活跃 todo 的名称 */
export function getActiveTodo(): string | null {
  return _activeTodo;
}

/** 设置当前活跃 todo */
export function setActiveTodo(name: string | null): void {
  _activeTodo = name;
}
