/**
 * 跨会话协作 IPC 通道一致性检查
 * 验证 main.js / preload.cjs / renderer（types + useElectronAPI + RightPanel）三方通道名与方法名对齐。
 * 运行：npx tsx scripts/test-collab-ipc.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const main = readFileSync(join(ROOT, 'electron/main.js'), 'utf8');
const preload = readFileSync(join(ROOT, 'electron/preload.cjs'), 'utf8');
const types = readFileSync(join(ROOT, 'electron/renderer/src/types/index.ts'), 'utf8');
const hook = readFileSync(join(ROOT, 'electron/renderer/src/hooks/useElectronAPI.ts'), 'utf8');
const panel = readFileSync(join(ROOT, 'electron/renderer/src/components/RightPanel.tsx'), 'utf8');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('═══ IPC 通道一致性 ═══');

// 1. 通道名：main handler ↔ preload invoke 一致（且唯一，防重复注册崩溃）
for (const channel of ['collab:sessions', 'collab:log']) {
  check(`通道 ${channel}: main 注册`, main.includes(`ipcMain.handle('${channel}'`), `main.js 缺少 handle('${channel}')`);
  check(`通道 ${channel}: main 唯一`, main.split(`ipcMain.handle('${channel}'`).length - 1 === 1, '重复注册会抛 Error');
  check(`通道 ${channel}: preload invoke`, preload.includes(`ipcRenderer.invoke('${channel}'`), `preload.cjs 缺少 invoke('${channel}')`);
}

// 2. 事件通道：main send ↔ preload on 一致
for (const event of ['collab:event', 'agent:identity-card']) {
  check(`事件 ${event}: main 发送`, main.includes(`webContents.send('${event}'`), `main.js 缺少 send('${event}')`);
  check(`事件 ${event}: preload 订阅`, preload.includes(`ipcRenderer.on('${event}'`), `preload.cjs 缺少 on('${event}')`);
}
// 3. types 声明 ↔ preload 暴露方法名一致
for (const method of ['getCollabSessions', 'getCollabLog', 'onCollabEvent', 'onIdentityCard', 'generateIdentityCard']) {
  check(`types 声明 ${method}`, types.includes(`${method}:`), `types/index.ts 缺少 ${method}`);
  check(`preload 暴露 ${method}`, preload.includes(`${method}:`), `preload.cjs 缺少 ${method}`);
}

// 4. useElectronAPI 包装 + 返回对象注册
for (const method of ['getCollabSessions', 'getCollabLog', 'onCollabEvent', 'onIdentityCard']) {
  check(`useElectronAPI 包装 ${method}`, hook.includes(`const ${method} = useCallback`), `useElectronAPI.ts 缺少包装 ${method}`);
  check(`useElectronAPI 注册 ${method}`, new RegExp(`\\b${method},\\s*$`, 'm').test(hook), `useElectronAPI.ts 返回对象未注册 ${method}`);
}

// 5. RightPanel 实际使用
for (const method of ['getCollabSessions', 'getCollabLog', 'onCollabEvent', 'onIdentityCard', 'generateIdentityCard']) {
  check(`RightPanel 使用 ${method}`, panel.includes(`api.${method}`), `RightPanel.tsx 未调用 ${method}`);
}
check('RightPanel 协作 Tab 存在', panel.includes(`currentTab === 'collab'`), '缺少 collab tab');
check('RightPanel 接收 runtimeData', panel.includes('runtimeData'), '缺少 runtimeData prop');

console.log('═══ 类型定义 ═══');
for (const t of ['IdentityCard', 'CollabSession', 'CollabLogEntry']) {
  check(`类型 ${t} 定义`, types.includes(`export interface ${t}`), `types/index.ts 缺少 ${t}`);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);



