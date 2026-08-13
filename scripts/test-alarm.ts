/**
 * test-alarm.ts — 闹钟工具验证
 * 覆盖：设定返回成功、到点注入消息、取消不触发、同 label 覆盖、列表、默认 label。
 */
import assert from 'node:assert';
import { alarmSetTool, alarmCancelTool, alarmListTool, alarmManager, setAlarmListener } from '../src/tools/alarm';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  let pass = 0;
  const ok = (name: string, cond: boolean) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

  const fired: string[] = [];
  setAlarmListener((msg) => { fired.push(msg); });

  console.log('── 设定成功（0.1 秒后触发）──');
  const r1 = await alarmSetTool.execute({ duration: 0.1, label: '测试' });
  ok('alarm_set 返回设定成功', r1.toString().includes('闹钟设定成功'));
  ok('返回含时长与注入消息预览', r1.toString().includes('0.1 秒') && r1.toString().includes('[闹钟]测试计时器已归零！'));
  await sleep(400);
  ok('到点注入 [闹钟]测试计时器已归零！', fired.length === 1 && fired[0] === '[闹钟]测试计时器已归零！');

  console.log('── 取消不触发 ──');
  await alarmSetTool.execute({ duration: 0.4, label: '取消测试' });
  const c = await alarmCancelTool.execute({ label: '取消测试' });
  ok('alarm_cancel 返回已取消', c.toString().includes('已取消闹钟'));
  await sleep(700);
  ok('取消后不触发', fired.length === 1);
  const c2 = await alarmCancelTool.execute({ label: '取消测试' });
  ok('取消不存在的闹钟提示未找到', c2.toString().includes('未找到闹钟'));

  console.log('── 同 label 覆盖 ──');
  await alarmSetTool.execute({ duration: 0.1, label: '覆盖' });
  await alarmSetTool.execute({ duration: 0.3, label: '覆盖' });
  await sleep(250);
  ok('覆盖后短闹钟不触发（仍 1 条）', fired.length === 1);
  await sleep(300);
  ok('覆盖后长闹钟触发', fired.length === 2 && fired[1] === '[闹钟]覆盖计时器已归零！');

  console.log('── 默认 label 与列表 ──');
  await alarmSetTool.execute({ duration: 2, label: '列表项' });
  const lst = await alarmListTool.execute({});
  ok('alarm_list 含闹钟与剩余时间', lst.toString().includes('列表项') && lst.toString().includes('还剩'));
  await alarmSetTool.execute({ duration: 5 });
  const lst2 = await alarmListTool.execute({});
  ok('默认 label 为等待', lst2.toString().includes('等待'));

  // 清理残留闹钟，避免进程挂住
  alarmManager.cancel('列表项');
  alarmManager.cancel('等待');
  console.log(`\n🎉 全部通过（${pass} 项断言）`);
}

main().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
