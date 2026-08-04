/** 命令叠加层逻辑测试：TerminalUI 的 palette 状态机 + 键盘分支 + filterPalette */
import { strict as assert } from 'node:assert';
import { TerminalUI } from '../src/ui-ink/TerminalUI';
import { filterPalette, type PaletteItem } from '../src/ui-ink/palette';

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}

// ── 1. filterPalette ──
{
  const items: PaletteItem[] = [
    { id: 'a', label: '帮助', group: '指令', shortcut: '/help', run: () => {} },
    { id: 'b', label: '清空屏幕', group: '指令', shortcut: 'ctrl+l', run: () => {} },
    { id: 'c', label: '清理工具调用', group: '工具', shortcut: 'ctrl+q', run: () => {} },
  ];
  assert.equal(filterPalette(items, '').length, 3, '空查询返回全部');
  assert.equal(filterPalette(items, '清空').length, 1, '按 label 过滤');
  assert.equal(filterPalette(items, '指令').length, 2, '按 group 过滤');
  assert.equal(filterPalette(items, 'HELP').length, 1, '大小写不敏感');
  assert.equal(filterPalette(items, '不存在').length, 0, '无匹配');
  ok('filterPalette 5 场景');
}

// ── 2. TerminalUI palette 状态机 ──
{
  const ui = new TerminalUI();
  const commands: string[] = [];
  const submits: string[] = [];
  ui.onCommand = (c) => commands.push(c);
  ui.onSubmit = (t) => submits.push(t);

  // 初始化默认命令
  ui.initPalette();
  const items = ui.getPaletteItems();
  assert.ok(items.length >= 8, `默认命令应 >=8，实际 ${items.length}`);
  ok(`默认命令清单 ${items.length} 项`);

  // toggle 开关
  assert.equal(ui.isPaletteOpen(), false, '初始关闭');
  ui.togglePalette();
  assert.equal(ui.isPaletteOpen(), true, '打开');
  const st1 = ui.getState();
  assert.equal(st1.paletteOpen, true, 'state.paletteOpen 同步');
  ui.togglePalette();
  assert.equal(ui.isPaletteOpen(), false, '再切换关闭');
  ok('togglePalette 开/关 + state 同步');

  // 搜索词
  ui.togglePalette();
  ui.setPaletteQuery('清空');
  assert.equal(ui.getState().paletteQuery, '清空', 'query 设置');
  assert.equal(ui.getState().paletteIndex, 0, '设置 query 后 index 归零');
  ok('setPaletteQuery');

  // movePaletteIndex 循环
  const visible = filterPalette(ui.getPaletteItems(), '清空');
  assert.equal(visible.length, 1);
  ui.movePaletteIndex(1, visible.length);
  assert.equal(ui.getState().paletteIndex, 0, '单元素循环回到 0');
  // 多元素
  const all = filterPalette(ui.getPaletteItems(), '');
  ui.setPaletteQuery('');
  ui.movePaletteIndex(1, all.length);
  assert.equal(ui.getState().paletteIndex, 1, '下移一格');
  ui.movePaletteIndex(-1, all.length);
  assert.equal(ui.getState().paletteIndex, 0, '上移回 0');
  ui.movePaletteIndex(-1, all.length);
  assert.equal(ui.getState().paletteIndex, all.length - 1, '上移循环到末尾');
  ok('movePaletteIndex 循环/边界');

  // runSelectedPalette 执行并关闭
  ui.setPaletteQuery('');
  ui.movePaletteIndex(0, all.length);
  // 选中 /help 项并执行
  const helpItem = all.find(i => i.id === 'help')!;
  ui.runSelectedPalette([helpItem]);
  assert.equal(ui.isPaletteOpen(), false, '执行后关闭');
  assert.ok(submits.includes('/help'), 'onSubmit 收到 /help');
  ok('runSelectedPalette 执行 /help + 关闭');

  // runPaletteItem（鼠标点击路径）
  ui.togglePalette();
  const clearItem = all.find(i => i.id === 'clear')!;
  ui.runPaletteItem(clearItem);
  assert.equal(ui.isPaletteOpen(), false, '点击执行后关闭');
  assert.ok(submits.includes('/clear'), 'onSubmit 收到 /clear');
  ok('runPaletteItem 鼠标点击路径');
}

// ── 3. handleKey 叠加层分支（模拟 Ink 按键） ──
{
  const ui = new TerminalUI();
  const commands: string[] = [];
  ui.onCommand = (c) => commands.push(c);
  ui.initPalette();

  // Ctrl+P 打开
  ui.handleKey('p', { ctrl: true });
  assert.equal(ui.isPaletteOpen(), true, 'Ctrl+P 打开面板');
  ok('Ctrl+P 打开');

  // 字符输入进搜索框
  ui.handleKey('h', {});
  assert.equal(ui.getState().paletteQuery, 'h', '字符进搜索框');
  ok('搜索字符输入');

  // 鼠标序列忽略
  ui.handleKey('\x1b[<0;10;5M', {});
  assert.equal(ui.getState().paletteQuery, 'h', '鼠标序列被忽略');
  ok('鼠标 SGR 序列忽略');

  // 上/下移动
  const before = ui.getState().paletteIndex;
  ui.handleKey('', { downArrow: true });
  assert.notEqual(ui.getState().paletteIndex, before, 'Down 移动选中');
  ok('Down 移动选中');

  // Escape 关闭
  ui.handleKey('', { escape: true });
  assert.equal(ui.isPaletteOpen(), false, 'Esc 关闭');
  ok('Esc 关闭');

  // 面板关闭时 Ctrl+P 再打开，且输入进主输入框
  ui.handleKey('p', { ctrl: true });
  assert.equal(ui.isPaletteOpen(), true, '再次打开');
  ui.handleKey('', { escape: true });
  ui.handleKey('x', {});
  assert.equal(ui.getCurrentInput(), 'x', '面板关闭后字符进主输入框');
  ok('关闭后输入恢复正常');

  // Ctrl+Q（面板打开时不应触发 memory_shorten）
  ui.handleKey('p', { ctrl: true });
  ui.handleKey('q', { ctrl: true });
  assert.equal(commands.length, 0, '面板打开时 Ctrl+Q 不触发命令');
  ui.handleKey('', { escape: true });
  ui.handleKey('q', { ctrl: true });
  assert.deepEqual(commands, ['memory_shorten'], '面板关闭后 Ctrl+Q 触发命令');
  ok('叠加层按键隔离');
}

console.log(`\n✅ palette UI 测试全部通过（${passed} 项）`);
