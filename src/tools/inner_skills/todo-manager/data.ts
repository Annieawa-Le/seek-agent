/**
 * todo-manager — 数据持久化层
 *
 * 提供 Todo/Step 类型定义、JSON 文件读写、查找和格式化等辅助方法。
 * 供 todo.ts 核心工具层调用，数据存储在工作区 .todo-data/todos.json。
 */

import fs from 'fs/promises';
import path from 'path';

// ── 数据模型 ──

export interface Step {
  content: string;
  completed: boolean;
}

export interface Todo {
  name: string;
  steps: Step[];
  createdAt: string;
}

// ── 文件路径 ──

const DATA_DIR = path.resolve(process.cwd(), '.todo-data');
const DATA_FILE = path.join(DATA_DIR, 'todos.json');

async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

// ── 读写接口 ──

export async function readTodos(): Promise<Todo[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function writeTodos(todos: Todo[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(DATA_FILE, JSON.stringify(todos, null, 2), 'utf-8');
}

// ── 辅助方法 ──

/** 按名称查找 todo，不存在则返回错误字符串 */
export function findTodo(todos: Todo[], name: string): { todo: Todo; index: number } | string {
  const idx = todos.findIndex(t => t.name === name);
  if (idx === -1) return `❌ 未找到名为 "${name}" 的 todo。`;
  return { todo: todos[idx], index: idx };
}

/** 格式化 step 列表为可读文本 */
export function formatSteps(todo: Todo): string {
  const lines = todo.steps.map((s, i) => {
    const status = s.completed ? '✅' : '⬜';
    return `  ${status} Step ${i + 1}: ${s.content}`;
  });
  const done = todo.steps.filter(s => s.completed).length;
  const total = todo.steps.length;
  return `📋 "${todo.name}"（${done}/${total} 步完成）：\n${lines.join('\n')}`;
}
