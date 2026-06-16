/**
 * todo.ts — 会话内待办事项管理工具（内存版）
 *
 * 所有的 todo 数据仅存在当前会话内存中，关闭即失。
 * 如需持久化保存/恢复，请配合 todo-manager skill 使用。
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getTodos, setTodos, getActiveTodo, setActiveTodo } from './todo-state';

// ── 类型 ──

interface Step {
  content: string;
  completed: boolean;
}

interface Todo {
  name: string;
  steps: Step[];
  createdAt: string;
}

// ── 内联辅助 ──

function findTodo(todos: Todo[], name: string): { todo: Todo; index: number } | string {
  const idx = todos.findIndex(t => t.name === name);
  if (idx === -1) return `❌ 未找到名为 "${name}" 的 todo。`;
  return { todo: todos[idx], index: idx };
}

function formatSteps(todo: Todo): string {
  const lines = todo.steps.map((s, i) => {
    const status = s.completed ? '✅' : '⬜';
    return `  ${status} Step ${i + 1}: ${s.content}`;
  });
  const done = todo.steps.filter(s => s.completed).length;
  return `📋 "${todo.name}"（${done}/${todo.steps.length} 步完成）：\n${lines.join('\n')}`;
}

// ── 工具定义 ──

export const createTodo = tool({
  description: '创建一条新的 todo，包含多个步骤（step）。steps 参数接受多条字符串，每条代表一个步骤。返回创建的 todo 概览。',
  inputSchema: z.object({
    name: z.string().describe('todo 的名称，后续操作以此名称引用'),
    steps: z.array(z.string()).describe('步骤列表，每个字符串代表一个步骤'),
  }),
  execute: async ({ name, steps }) => {
    const todos = getTodos();
    if (todos.some(t => t.name === name)) {
      return `❌ 已存在名为 "${name}" 的 todo。`;
    }

    const todo: Todo = {
      name,
      steps: steps.map(s => ({ content: s, completed: false })),
      createdAt: new Date().toISOString(),
    };
    todos.push(todo);
    setTodos(todos);
    setActiveTodo(name);

    return `✅ 已创建 todo "${name}"（共 ${steps.length} 步）：\n${formatSteps(todo)}`;
  },
});

export const finishStep = tool({
  description: '按顺序将 todo 中下一个未完成的 step 标记为"已完成"。返回更新后的 todo 状态。',
  inputSchema: z.object({
    name: z.string().describe('todo 的名称'),
  }),
  execute: async ({ name }) => {
    const todos = getTodos();
    const found = findTodo(todos, name);
    if (typeof found === 'string') return found;

    const { todo, index } = found;
    const nextStep = todo.steps.find(s => !s.completed);
    if (!nextStep) {
      return `■ "${name}" 的所有步骤已完成！\n${formatSteps(todo)}`;
    }

    nextStep.completed = true;
    todos[index] = todo;
    setTodos(todos);

    const stepNum = todo.steps.indexOf(nextStep) + 1;
    return `✅ Step ${stepNum} 已完成：${nextStep.content}\n\n${formatSteps(todo)}`;
  },
});

export const undoStep = tool({
  description: '将最近一个被标记为"已完成"的 step 回退为未完成状态。相当于撤销一次 finish_step。',
  inputSchema: z.object({
    name: z.string().describe('todo 的名称'),
  }),
  execute: async ({ name }) => {
    const todos = getTodos();
    const found = findTodo(todos, name);
    if (typeof found === 'string') return found;

    const { todo, index } = found;
    const lastDoneIdx = todo.steps.map((s, i) => ({ s, i })).reverse().find(item => item.s.completed);
    if (!lastDoneIdx) {
      return `■ "${name}" 没有已完成的步骤需要回退。\n${formatSteps(todo)}`;
    }

    todo.steps[lastDoneIdx.i].completed = false;
    todos[index] = todo;
    setTodos(todos);

    return `↩️ 已撤销 Step ${lastDoneIdx.i + 1}：${todo.steps[lastDoneIdx.i].content}\n\n${formatSteps(todo)}`;
  },
});

export const rerollStep = tool({
  description: '将 todo 中所有 step 重置为未完成状态，相当于重新开始。',
  inputSchema: z.object({
    name: z.string().describe('todo 的名称'),
  }),
  execute: async ({ name }) => {
    const todos = getTodos();
    const found = findTodo(todos, name);
    if (typeof found === 'string') return found;

    const { todo, index } = found;
    todo.steps.forEach(s => { s.completed = false; });
    todos[index] = todo;
    setTodos(todos);

    return `🔄 已重置 "${name}" 的所有步骤为未完成。\n\n${formatSteps(todo)}`;
  },
});

export const delStep = tool({
  description: '按序号删除指定 step。序号从 1 开始，删除后后面的 step 序号自动前移。',
  inputSchema: z.object({
    name: z.string().describe('todo 的名称'),
    step: z.number().describe('要删除的步骤序号（从 1 开始）'),
  }),
  execute: async ({ name, step }) => {
    const todos = getTodos();
    const found = findTodo(todos, name);
    if (typeof found === 'string') return found;

    const { todo, index } = found;
    if (step < 1 || step > todo.steps.length) {
      return `❌ 序号无效：${step}，该 todo 共有 ${todo.steps.length} 步（序号 1-${todo.steps.length}）。`;
    }

    const removed = todo.steps.splice(step - 1, 1)[0];
    todos[index] = todo;
    setTodos(todos);

    return `■ 已删除 Step ${step}：${removed.content}\n\n${formatSteps(todo)}`;
  },
});

export const readTodo = tool({
  description: '查看指定 todo 中所有 step 及其完成状态。',
  inputSchema: z.object({
    name: z.string().describe('todo 的名称'),
  }),
  execute: async ({ name }) => {
    const todos = getTodos();
    const found = findTodo(todos, name);
    if (typeof found === 'string') return found;

    return formatSteps(found.todo);
  },
});

export const delTodo = tool({
  description: '按名称删除整个 todo 及其所有步骤。',
  inputSchema: z.object({
    name: z.string().describe('要删除的 todo 名称'),
  }),
  execute: async ({ name }) => {
    const todos = getTodos();
    const found = findTodo(todos, name);
    if (typeof found === 'string') return found;

    todos.splice(found.index, 1);
    setTodos(todos);

    return `■ 已删除 todo "${name}"。`;
  },
});

export const activeTodo = tool({
  description: '查看或设置当前活跃的 todo。不传 name 则返回当前活跃 todo 名称；传 name 则切换活跃 todo。',
  inputSchema: z.object({
    name: z.string().optional().describe('要设为活跃的 todo 名称，不传则仅查看当前活跃'),
  }),
  execute: async ({ name }) => {
    if (name === undefined) {
      const active = getActiveTodo();
      return active
        ? `🎯 当前活跃 todo："${active}"（使用 read_todo 查看详情）`
        : '■ 当前没有设置活跃 todo。';
    }

    const todos = getTodos();
    const found = findTodo(todos, name);
    if (typeof found === 'string') return found;

    setActiveTodo(name);
    return `🎯 已切换活跃 todo 为 "${name}"。`;
  },
});
