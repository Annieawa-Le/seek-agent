/**
 * Bulk 格式化覆盖测试
 *
 * 穷举每种 RawBulk 的每个 action 取值，分别过 toAIText / toTUIText / toWebUI，
 * 断言没有任何一条落到 `JSON.stringify(bulk)` 的裸 JSON 兜底。
 *
 * 为什么需要：三个格式化器都是「外层 switch(type) + 内层 switch(action)」结构，
 * 内层漏一个 action 不会报编译错（有 default 兜底），界面上就直出一坨 JSON。
 * 真实踩过：replace_str 的 action='replace' 没进 formatPatchWebUI 的内层 switch。
 *
 * 运行：pnpm tsx scripts/test-bulk-formatters.ts
 */
import { toAIText, toTUIText, toWebUI } from '../src/tools/raw-bulk-formatters';

/** 每种 bulk 的 action 取值 + 最小可用样本（与 raw-bulk-types.ts 的联合类型保持一致） */
const SAMPLES: Record<string, Array<Record<string, unknown>>> = {
  'file-write': [{ action: 'create' }, { action: 'replace' }],
  patch: [
    { action: 'add' }, { action: 'del' }, { action: 'modify' },
    { action: 'replace' }, { action: 'undo' }, { action: 'history' },
  ],
  desk: [
    { action: 'add', totalCount: 1 }, { action: 'list', totalCount: 1, entries: [] },
    { action: 'remove', totalCount: 1 }, { action: 'clear', totalCount: 1 },
  ],
  task: [
    { action: 'execute', taskName: 't' }, { action: 'switch', taskName: 't' },
    { action: 'list', tasks: [] }, { action: 'kill', taskName: 't' },
  ],
  todo: [
    { action: 'create', todoName: 't' }, { action: 'finish', todoName: 't' },
    { action: 'finish-to', todoName: 't', step: 1 },
    { action: 'undo', todoName: 't' }, { action: 'reroll', todoName: 't' },
    { action: 'del-step', todoName: 't', step: 1 }, { action: 'read', todoName: 't' },
    { action: 'del', todoName: 't' }, { action: 'active', todoName: 't' },
  ],
  memory: [
    { action: 'focus' }, { action: 'shorten' }, { action: 'add' }, { action: 'update' },
    { action: 'touch' }, { action: 'remove' }, { action: 'list' }, { action: 'clear' },
    { action: 'remember' }, { action: 'recall' }, { action: 'stats' },
  ],
  mission: [
    { action: 'start', name: 'seg' },
    { action: 'accomplish', name: 'seg', worklogId: 'W1', title: 't', messagesRemoved: 1, summary: 's' },
    { action: 'cancel', name: 'seg' },
  ],
  alarm: [
    { action: 'set', label: 'a', durationSec: 5, fireAt: '10:00' },
    { action: 'cancel', label: 'a', ok: true },
    { action: 'list', alarms: [] },
  ],
  collab: [{ action: 'send', target: 'sess', delivered: true }],
  worklog: [
    { action: 'recall', found: false, query: 'q', msg: 'm' },
    { action: 'recall', found: true, query: 'q', id: 'W1', title: 't', summary: 's', msg: 'm' },
    { action: 'recall-original', found: true, query: 'q', msg: 'raw' },
  ],
  'cmd-log': [
    { action: 'read', found: false },
    { action: 'read', found: true, filePath: 'f', size: 3, content: 'abc' },
  ],
};

/** 无 action 维度的 bulk（只有单一形态） */
const PLAIN_TYPES: Record<string, Record<string, unknown>> = {
  read: { filePath: 'a.ts', lineCount: 1, charCount: 1, content: 'x' },
  search: { keyword: 'k', totalCount: 0 },
  'search-content': { keyword: 'k', filePath: 'a.ts', totalCount: 0 },
  exec: { command: 'echo', exitCode: 0, stdout: 'ok' },
};

let passed = 0;
const failures: string[] = [];

/** 判断输出是否落到了 `JSON.stringify(bulk)` 兜底（HTML 里表现为裸 JSON） */
function isRawJson(out: string): boolean {
  return /[{,]\s*"type"\s*:/.test(out);
}

const FORMATTERS = [
  ['toWebUI', (b: any) => String(toWebUI(b).html ?? '')],
  ['toTUIText', (b: any) => toTUIText(b)],
  ['toAIText', (b: any) => toAIText(b)],
] as const;

function check(type: string, variant: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const bulk = {
    type, description: 'desc', filePath: 'a.ts', diff: '--- a\n+++ b', undoId: 'U1',
    totalCount: 0, found: true, query: 'q', msg: 'm', taskName: 't', todoName: 't', name: 'seg',
    ...extra, ...variant,
  } as any;
  const tag = `${type}/${String(variant.action ?? '-')}`;
  for (const [name, fn] of FORMATTERS) {
    let out = '';
    try {
      out = fn(bulk);
    } catch (e: any) {
      failures.push(`${tag} · ${name} 抛错：${e.message}`);
      continue;
    }
    if (isRawJson(out)) {
      failures.push(`${tag} · ${name} 落到裸 JSON 兜底`);
    } else {
      passed++;
    }
  }
}

for (const [type, variants] of Object.entries(SAMPLES)) {
  for (const v of variants) check(type, v, { description: 'desc' });
}
for (const [type, v] of Object.entries(PLAIN_TYPES)) {
  check(type, v);
}

const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`✅ 所有 bulk × action × 三端格式化均有专属渲染（${total} 项断言）`);
} else {
  for (const f of failures) console.log(`  ❌ ${f}`);
  console.log(`\n${passed} 通过，${failures.length} 失败（共 ${total} 项）`);
  process.exitCode = 1;
}
