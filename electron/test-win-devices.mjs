/**
 * electron/test-win-devices.mjs — RemoteBridge 信任设备逻辑测试（不起 Electron / 不起真实中继）
 *
 * 直接实例化 RemoteBridge（不 start，避免连接真实中继），手动喂 trust 消息（JSON 字符串，模拟 ws 消息），
 * mock broadcastEvent / ws.send 验证 Windows 端设备面板核心链路：
 *   1. trust-updated 保存/更新本地 JSON（含 token）+ 广播 remote:devices
 *   2. trust-list 合并 online 状态 + 新增本地没有的设备（token 占位）+ 同步删除中继侧已删设备
 *   3. trust-revoked 本地删除
 *   4. revokeTrustedDevice 发出正确的 trust-revoke 消息 + 本地删除
 *   5. 持久化：重新实例化从 trusted-devices.json 恢复
 *   6. getTrustedDevices 不含 token（凭证不泄漏给渲染层）
 *
 * 运行：node test-win-devices.mjs
 */
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { RemoteBridge } from './remote-bridge.js';

let passed = 0;
let failed = 0;
function pass(name) { passed += 1; console.log(`  ✔ PASS  ${name}`); }
function fail(name, err) { failed += 1; console.error(`  ✘ FAIL  ${name}${err ? `\n      ${err.message}` : ''}`); }
function check(name, fn) { try { fn(); pass(name); } catch (err) { fail(name, err); } }

/** 构造一个未启动的 bridge（trustedDevicesFile 指向临时文件；ws mock 捕获 sendRaw 消息） */
function makeBridge(dir, events, sent) {
  const bridge = new RemoteBridge({
    relayUrl: 'ws://127.0.0.1:1', // 不 start，不会真实连接
    deviceId: 'seek-windows-test-001',
    routeToCurrent: () => {},
    restartCurrentAgent: () => {},
    invokeHandler: async () => ({}),
    broadcastEvent: (channel, payload) => events.push({ channel, payload }),
    trustedDevicesFile: join(dir, 'trusted-devices.json'),
    log: () => {},
    warn: () => {},
  });
  // mock ws：让 sendRaw（trust-revoke / trust-request / trust-list）走捕获通道
  bridge.ws = {
    readyState: WebSocket.OPEN,
    send: (data) => sent.push(JSON.parse(data.toString())),
  };
  return bridge;
}

const dir = mkdtempSync(join(tmpdir(), 'seek-devices-'));
let bridge = null;
try {
  console.log('\n[1] trust-updated 保存新设备（含 token）');
  const events = [];
  const sent = [];
  bridge = makeBridge(dir, events, sent);
  bridge.handleMessage(JSON.stringify({ type: 'trust-updated', remoteId: 'phone-a', label: '小米手机', token: 'tok-aaa' }));
  check('trust-updated 保存设备到内存', () => {
    assert.strictEqual(bridge.devices.length, 1);
    assert.strictEqual(bridge.devices[0].remoteId, 'phone-a');
    assert.strictEqual(bridge.devices[0].label, '小米手机');
    assert.strictEqual(bridge.devices[0].token, 'tok-aaa');
  });
  check('trust-updated 写入本地 JSON', () => {
    const saved = JSON.parse(readFileSync(join(dir, 'trusted-devices.json'), 'utf8'));
    assert.ok(Array.isArray(saved.devices) && saved.devices.length === 1, 'JSON 应有 1 个设备');
    assert.strictEqual(saved.devices[0].token, 'tok-aaa');
  });
  check('trust-updated 广播 remote:devices', () => {
    const ev = events.find(e => e.channel === 'remote:devices');
    assert.ok(ev, '应广播 remote:devices');
    assert.strictEqual(ev.payload.devices.length, 1);
  });

  console.log('\n[2] trust-updated 更新已有设备 label/token（不重复添加）');
  bridge.handleMessage(JSON.stringify({ type: 'trust-updated', remoteId: 'phone-a', label: '小米 15', token: 'tok-bbb' }));
  check('更新而非新增', () => {
    assert.strictEqual(bridge.devices.length, 1, '设备数应保持 1');
    assert.strictEqual(bridge.devices[0].label, '小米 15');
    assert.strictEqual(bridge.devices[0].token, 'tok-bbb');
  });

  console.log('\n[3] trust-list 合并 online 状态 + 新增 + 同步删除');
  bridge.handleMessage(JSON.stringify({
    type: 'trust-list',
    items: [
      { remoteId: 'phone-a', label: '小米 15', online: true, createdAt: '2026-01-01T00:00:00.000Z' },
      { remoteId: 'phone-b', label: '备用机', online: false, createdAt: '2026-02-02T00:00:00.000Z' },
    ],
  }));
  check('trust-list 合并 online 状态', () => {
    const list = bridge.getTrustedDevices();
    assert.strictEqual(list.find(d => d.remoteId === 'phone-a').online, true);
    assert.strictEqual(list.find(d => d.remoteId === 'phone-b').online, false);
  });
  check('trust-list 新增本地没有的设备（token 占位）', () => {
    const b = bridge.devices.find(d => d.remoteId === 'phone-b');
    assert.ok(b, 'phone-b 应被新增');
    assert.strictEqual(b.token, '', 'trust-list 不含 token，应留空');
    assert.strictEqual(b.trustedAt, '2026-02-02T00:00:00.000Z');
  });
  check('trust-list 同步删除中继侧已不存在的设备', () => {
    // 先在本地加一个中继侧没有的 phone-c，再拉 trust-list（不含 phone-b/phone-c）→ 应被清掉
    bridge.handleMessage(JSON.stringify({ type: 'trust-updated', remoteId: 'phone-c', label: '旧设备', token: 'tok-ccc' }));
    bridge.handleMessage(JSON.stringify({ type: 'trust-list', items: [{ remoteId: 'phone-a', online: false }] }));
    assert.ok(!bridge.devices.find(d => d.remoteId === 'phone-c'), 'phone-c 应被 trust-list 同步删除');
    assert.ok(!bridge.devices.find(d => d.remoteId === 'phone-b'), 'phone-b 不在列表应被删除');
    assert.strictEqual(bridge.devices.length, 1);
    assert.strictEqual(bridge.getTrustedDevices()[0].online, false, 'online 应更新为 false');
  });
  check('getTrustedDevices 不含 token（不泄漏凭证）', () => {
    const list = bridge.getTrustedDevices();
    assert.ok(!('token' in list[0]), '不应暴露 token');
  });

  console.log('\n[4] trust-revoked 删除本地设备');
  bridge.handleMessage(JSON.stringify({ type: 'trust-revoked', remoteId: 'phone-a' }));
  check('trust-revoked 本地删除 + online 清除', () => {
    assert.strictEqual(bridge.devices.length, 0);
    assert.strictEqual(bridge.onlineMap['phone-a'], undefined);
  });

  console.log('\n[5] revokeTrustedDevice 发出 trust-revoke + 本地删除');
  bridge.handleMessage(JSON.stringify({ type: 'trust-updated', remoteId: 'phone-x', label: 'X', token: 'tok-x' }));
  sent.length = 0;
  const res = bridge.revokeTrustedDevice('phone-x');
  check('revoke 返回 ok / sent', () => {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.sent, true);
  });
  check('revoke 发出正确的 trust-revoke 消息', () => {
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0], { type: 'trust-revoke', relayDeviceId: 'seek-windows-test-001', remoteId: 'phone-x' });
  });
  check('revoke 本地立即删除 + 广播', () => {
    assert.strictEqual(bridge.devices.length, 0);
    const ev = events.filter(e => e.channel === 'remote:devices').pop();
    assert.strictEqual(ev.payload.devices.length, 0);
  });
  // 重新信任一个设备，供持久化恢复断言
  bridge.handleMessage(JSON.stringify({ type: 'trust-updated', remoteId: 'phone-x', label: 'X', token: 'tok-x' }));

  console.log('\n[6] 持久化：重新实例化从 JSON 恢复');
  const bridge2 = makeBridge(dir, [], []);
  check('重启后从 trusted-devices.json 恢复设备', () => {
    assert.strictEqual(bridge2.devices.length, 1);
    assert.strictEqual(bridge2.devices[0].remoteId, 'phone-x');
    assert.strictEqual(bridge2.devices[0].token, 'tok-x');
  });

  console.log(`\n全部通过: ${passed} PASS, ${failed} FAIL`);
  if (failed > 0) process.exit(1);
} finally {
  try { if (bridge) bridge.stop(); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
}

