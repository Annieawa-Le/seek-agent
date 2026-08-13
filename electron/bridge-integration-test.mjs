/**
 * electron/bridge-integration-test.mjs — RemoteBridge 集成测试（不起 Electron）
 *
 * 测 remote-bridge.js 本体 + startRemoteBridge 注入 mock 依赖，配合真实中继
 * （seek-mobile/relay-server/server.js）验证完整链路：
 *   1. pair-code 经 broadcastEvent 回调收到
 *   2. peer-online 后 rpc(getCurrentSession) 往返成功
 *   3. event(agent:message) 推送到达 remote
 *   4. 断线重连：kill 中继 → peer 断开广播 → 重启中继 → bridge 自动重连拿到新 pair-code
 *
 * 运行：node bridge-integration-test.mjs
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { startRemoteBridge } from './remote-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 真实中继脚本（seek-mobile/relay-server/server.js）
const RELAY_SERVER = resolve(__dirname, '..', '..', 'seek-mobile', 'relay-server', 'server.js');
const RELAY_PORT = 18081;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

let passed = 0;
let failed = 0;
function pass(name) {
  passed += 1;
  console.log(`  ✔ PASS  ${name}`);
}
function fail(name, err) {
  failed += 1;
  console.error(`  ✘ FAIL  ${name}${err ? `\n      ${err.message}` : ''}`);
}

/** 轮询等待条件成立（20ms 间隔） */
function waitFor(predicate, timeoutMs, desc) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      let val = null;
      try { val = predicate(); } catch { /* 继续等 */ }
      if (val) {
        clearInterval(timer);
        resolve(val);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${desc}`));
      }
    }, 20);
  });
}

/** 启动真实中继，等待 listening；同端口快速重启时重试 EADDRINUSE */
function startRelay(port) {
  return new Promise((resolvePromise, reject) => {
    const attempt = (tryNum) => {
      const proc = spawn(process.execPath, [RELAY_SERVER], {
        cwd: dirname(RELAY_SERVER),
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (d) => {
        out += d.toString();
        if (out.includes('listening')) resolvePromise(proc);
      });
      proc.stderr.on('data', (d) => {
        const text = d.toString();
        if (text.includes('EADDRINUSE') && tryNum < 20) {
          proc.kill();
          setTimeout(() => attempt(tryNum + 1), 300);
          return;
        }
        out += text;
      });
      proc.on('exit', (code) => {
        if (code !== null && !out.includes('listening')) {
          reject(new Error(`relay exited before listening (code=${code})`));
        }
      });
    };
    attempt(0);
  });
}

/** mock remote 端：连接中继 → auth(code) → 等待 peer-online */
function connectRemote(code) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const remote = { ws, events: [], rpcResults: [] };
    const timer = setTimeout(() => reject(new Error('remote connect timeout')), 15000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', role: 'remote', code }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'peer-online') {
        clearTimeout(timer);
        remote.peerOnline = true;
        resolvePromise(remote);
      } else if (msg.type === 'data') {
        const payload = msg.payload;
        if (payload.type === 'rpc-result') remote.rpcResults.push(payload);
        else if (payload.type === 'event') remote.events.push(payload);
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function main() {
  return new Promise(async (resolvePromise, reject) => {
    let relayProc = null;
    let bridge = null;
    let remote = null;

    try {
      // ── 1. 启动真实中继 ──
      console.log('\n[1] 启动真实中继…');
      relayProc = await startRelay(RELAY_PORT);
      console.log(`    relay listening on ${RELAY_PORT}`);
      pass('启动真实中继');

      // ── 2. mock 依赖 + startRemoteBridge ──
      const events = []; // broadcastEvent 记录 { channel, payload }
      const routeCalls = [];
      const invokeCalls = [];
      let restartCalls = 0;

      const mockInvokeHandler = async (method, params) => {
        invokeCalls.push({ method, params });
        if (method === 'getCurrentSession') return { sessionId: 'test-1' };
        if (method === 'getWorkdir') return 'C:\\mock-workdir';
        if (method === 'readGitStatus') return [{ status: 'M', file: 'main.js' }];
        throw new Error(`mock invokeHandler: unknown method ${method}`);
      };

      bridge = startRemoteBridge({
        relayUrl: RELAY_URL,
        deviceId: 'seek-windows-test-001',
        routeToCurrent: (msg) => routeCalls.push(msg),
        restartCurrentAgent: () => { restartCalls += 1; },
        invokeHandler: mockInvokeHandler,
        broadcastEvent: (channel, payload) => events.push({ channel, payload }),
        log: () => {},   // 静默
        warn: () => {},
      });
      assert.ok(bridge, 'startRemoteBridge 应返回实例');
      console.log('\n[2] startRemoteBridge 注入 mock 依赖');
      pass('startRemoteBridge 返回实例');

      // ── 3. pair-code 经 broadcastEvent 收到 ──
      console.log('\n[3] 等待 pair-code 广播…');
      const pairEvent = await waitFor(
        () => events.find((e) => e.channel === 'remote:pair-code'),
        10000,
        'remote:pair-code broadcast'
      );
      const pairCode = pairEvent.payload.code;
      assert.ok(/^[A-Z2-9]{6}$/.test(pairCode), `pair-code 格式异常: ${pairCode}`);
      pass(`pair-code 经 broadcastEvent 收到: ${pairCode}`);

      // ── 4. mock remote 连入配对 → peer-online → remote:status connected ──
      console.log('\n[4] mock remote 端连入配对…');
      remote = await connectRemote(pairCode);
      pass('remote 端 peer-online');
      await waitFor(
        () => events.find((e) => e.channel === 'remote:status' && e.payload.connected === true),
        5000,
        'remote:status connected broadcast'
      );
      pass('bridge 广播 remote:status {connected:true}');

      // ── 5. rpc(getCurrentSession) 往返 ──
      console.log('\n[5] rpc(getCurrentSession) 往返…');
      const rpcId = 'rpc-1';
      remote.ws.send(JSON.stringify({ type: 'data', seq: 1, payload: { type: 'rpc', id: rpcId, method: 'getCurrentSession', params: [] } }));
      const rpcResult = await waitFor(
        () => remote.rpcResults.find((r) => r.id === rpcId),
        5000,
        'rpc-result getCurrentSession'
      );
      assert.strictEqual(rpcResult.ok, true, 'rpc-result ok 应为 true');
      assert.deepStrictEqual(rpcResult.data, { sessionId: 'test-1' }, 'rpc-result data 应为 mock 返回值');
      assert.deepStrictEqual(invokeCalls[0], { method: 'getCurrentSession', params: [] }, 'invokeHandler 应收到 method+params');
      pass('rpc(getCurrentSession) 往返成功，返回 {sessionId:"test-1"}');

      // ── 6. event(agent:message) 推送到达 remote ──
      console.log('\n[6] event(agent:message) 推送…');
      const payload = { role: 'agent', content: 'hello from bridge', sessionId: 'test-1' };
      assert.strictEqual(bridge.sendEvent('agent:message', payload), true, 'sendEvent 应返回 true（已配对）');
      const evt = await waitFor(
        () => remote.events.find((e) => e.channel === 'agent:message'),
        5000,
        'remote 收到 agent:message event'
      );
      assert.deepStrictEqual(evt.payload, payload, 'event payload 应原样到达');
      pass('event(agent:message) 原样到达 remote');

      // ── 7. 断线重连：kill 中继 → 广播断开 → 重启中继 → 自动重连拿新 pair-code ──
      console.log('\n[7] 断线重连…');
      relayProc.kill();
      relayProc = null;
      await waitFor(
        () => events.find((e) => e.channel === 'remote:status' && e.payload.connected === false),
        8000,
        'remote:status {connected:false}（peer 断开）'
      );
      pass('peer 断开后 broadcastEvent 收到 remote:status {connected:false}');

      // 重启中继（同端口），bridge 应指数退避后自动重连并重新申请配对码
      const pairEventsBefore = events.filter((e) => e.channel === 'remote:pair-code').length;
      relayProc = await startRelay(RELAY_PORT);
      const newPairEvent = await waitFor(
        () => {
          const list = events.filter((e) => e.channel === 'remote:pair-code');
          return list.length > pairEventsBefore ? list[list.length - 1] : null;
        },
        20000,
        '重连后重新收到 pair-code'
      );
      assert.notStrictEqual(newPairEvent.payload.code, pairCode, '重连后应拿到新 pair-code');
      pass(`断线重连成功，重新拿到 pair-code: ${newPairEvent.payload.code}`);

      console.log(`\n全部通过: ${passed} PASS, ${failed} FAIL`);
      if (failed > 0) reject(new Error(`${failed} 个断言失败`));
      else resolvePromise();
    } catch (err) {
      console.error(`\n[ERROR] ${err.message}`);
      failed += 1;
      console.log(`\n结果: ${passed} PASS, ${failed} FAIL`);
      reject(err);
    } finally {
      try { if (remote) remote.ws.close(); } catch { /* ignore */ }
      try { if (bridge) bridge.stop(); } catch { /* ignore */ }
      try { if (relayProc) relayProc.kill(); } catch { /* ignore */ }
    }
  });
}

main().then(
  () => { console.log('\n=== bridge-integration-test ALL PASS ==='); process.exit(0); },
  (err) => { console.error(`\n=== bridge-integration-test FAILED ===\n${err.message}`); process.exit(1); }
);

