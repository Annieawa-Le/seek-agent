# WebUI 卡死事故复盘（Postmortem）

> 日期：2026-08-01
> 影响：Electron WebUI 打开即卡死、窗口无响应、鼠标拖动偏移、关闭无效
> 结论：渲染层 `useEffect` 无限循环导致渲染进程 247% CPU + 主进程 211% CPU

---

## 一、问题现象

- WebUI 打开后窗口冻结，点击无响应
- 任务管理器显示进程 CPU 持续高位
- 主进程 stdout 以每秒数十条的速度刷错误日志（14 秒 2115 行）
- 拖动窗口时鼠标位置偏移（典型的主线程阻塞表现）

## 二、排查历程（2 小时）

按时间顺序还原，每一步都是真实的弯路：

| 阶段 | 怀疑对象 | 结论 |
|------|---------|------|
| 1 | Electron 进程残留（发现 4 个实例） | 是干扰项，非根因 |
| 2 | `readFileTree` 同步递归遍历大目录（ai-ide 8048 文件 + repos 16645） | 确实阻塞近 1 秒，已修（改单层懒加载），但非根因 |
| 3 | `git status` 用 `execSync` 阻塞 | 已改异步，非根因 |
| 4 | main.js 296 行多余 `}` 语法错误 | 启动即崩溃，已修，非本次卡死根因 |
| 5 | dev watch 递归监听 dist 触发反复 reload | 已修（只监听 index.html），非根因 |
| 6 | 渲染层死循环（埋 renderCount 探针） | App 正常 render 13 次后稳定，排除 |
| 7 | 主进程挂载期同步 handler | 实测总耗时仅 129ms，排除 |
| 8 | GPU 加速崩溃（中文/特殊字符路径） | `disableHardwareAcceleration()` 已加，非根因 |
| 9 | 主进程 `[diag]` 计数器探针 | 回调全部低频（2-8 次/10 秒），主进程不忙，排除 |
| 10 | 渲染层 `[perf] fps=120` rAF 探针 | **误导**：fps 高是循环的症状，不是原因 |
| 11 | `fs:listSessions` 全量 JSON.parse 20MB（77 个文件） | 是放大器，非根因（加缓存后 main 仍 206%） |
| 12 | **`useElectronAPI` 返回不稳定对象 → useEffect 无限循环** | ✅ **真正根因** |

**关键转折**：用户写出分级检测脚本 `_test_steps.ps1`（STEP 0-5 逐步加回 main.js 功能），数据一目了然：

```
STEP 1（agent+输入转发）: RENDERER 9.8%  main 3%      ← 正常基线
STEP 2（+会话管理）:      RENDERER 247%  main 150%    ← 渲染层爆炸
STEP 4（+文件树等）:      RENDERER 11.7% main 209%    ← 渲染恢复，main 爆炸
```

STEP 2 的渲染层爆炸点直指**会话管理触发链**，最终锁定渲染层 hook。

## 三、根因分析

**一句话：`useElectronAPI()` 每次渲染返回全新对象 → 所有 `useCallback(…, [api])` 每次渲染失效 → `useEffect` 无限循环。**

```tsx
// electron/renderer/src/hooks/useElectronAPI.ts（修复前）
export function useElectronAPI() {
  const api = window.electronAPI;   // 稳定（preload 注入）
  // ... 一堆 useCallback(..., [api]) 都依赖 api
  return { isAvailable, onMessage, onStatus, ... };  // ← 每次渲染都是新对象！
}
```

```tsx
// LeftSidebar.tsx（无限循环的现场）
const api = useElectronAPI();                       // 每次渲染新对象
const loadActive = useCallback(async () => { ... }, [api]);  // 每次渲染重建
useEffect(() => {
  loadSessions(); loadStatic(); loadActive();       // 每次渲染重跑！
  const t = setInterval(loadActive, 5000);
  return () => clearInterval(t);
}, [loadSessions, loadStatic, loadActive]);         // 依赖每次都变
```

**循环链路**：

```
useEffect 重跑
  → loadActive() 成功（session:list）→ setActiveSessionIds()
  → 重新渲染
  → api 返回新对象 → loadSessions/loadStatic/loadActive 重建
  → useEffect 依赖变化 → 又重跑
  → loadSessions() → fs:listSessions 全量 JSON.parse 20MB  ← 主进程被拖死
  → loadStatic() → sidebar:static（无 handler 时）→ 报错刷屏
```

**为什么 STEP 1 不爆炸**：STEP 1 时 `session:list` 没有 handler → `loadActive()` 失败 → 不 setState → 不触发重新渲染 → 循环启动不了。STEP 2 加回 handler 后 `loadActive` 成功，循环被点燃。

**为什么加了 `fs:listSessions` 缓存后 main 仍 206%**：缓存只优化了单次调用的耗时，但循环本身还在（每秒多次），加上每次循环 `loadStatic` 失败 + console-message 转发打印错误，主进程依然被高频 IPC 和错误日志淹没。

## 四、修复方案

### 修复 1（根治）：`useElectronAPI` 返回稳定对象

```tsx
// electron/renderer/src/hooks/useElectronAPI.ts（修复后）
import { useMemo } from 'react';
// ...
  return useMemo(() => ({
    isAvailable: !!api,
    onMessage, onStatus, /* ...全部方法 */
  }), [api]);   // api（window.electronAPI）本身稳定 → useMemo 只算一次 → 返回值稳定
```

所有使用方的 `useCallback(..., [api])` 依赖稳定 → `useEffect` 只挂载一次 → 循环打破。

### 修复 2（加固）：`fs:listSessions` 签名缓存

```js
// electron/main.js
// 签名 = 文件名:大小:mtime，无变化直接返回缓存
const sig = files
  .filter(f => f.name.endsWith('.json'))
  .map(f => { const st = statSync(join(sessionsDir, f.name));
              return `${f.name}:${st.size}:${st.mtimeMs}`; })
  .join('|');
if (sig === __sessionsSig) return __sessionsCache;
// ...解析后
__sessionsSig = sig;
__sessionsCache = sessions;
```

避免每次轮询都全量 `JSON.parse` 20MB sessions 目录（77 个文件，单个最大 1.27MB）。

## 五、验证结果（正式 electron/main.js 实测）

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| main CPU | 211% | **1.5%** |
| RENDERER CPU | 247% | **0%** |
| 日志错误 | 2115 行/14 秒 | **0 行** |
| 窗口响应 | 卡死 | 正常 |

## 六、经验教训

1. **React 的稳定引用是硬约束**：任何 `useCallback` 的依赖如果指向"每次渲染新建的对象"，等于没有依赖。hook 返回对象时一律 `useMemo` 包裹。
2. **无限循环的典型特征**：`useEffect` 里同时有"成功的 setState"和"失败的 IPC 调用"——成功的那条维持渲染，失败的那条刷错误日志，双杀 CPU。
3. **日志刷屏本身就是线索**：2115 行 `No handler registered` 不是噪音，是循环的指纹。看到高频重复错误，先怀疑调用方在死循环重试。
4. **分级检测（二分定位）效率碾压猜测**：`_test_steps.ps1`（STEP 0-5 逐步加功能 + CPU 采样）一次跑完直接给出爆炸点，比逐文件 review 快得多。
5. **症状 ≠ 原因**：`fps=120`、`fs:listSessions` 慢、GPU 崩溃都是**循环的症状或放大器**，不要被中间证据带偏。

## 七、遗留工具（保留在工作区）

- `_step_main.js` + `_test_steps.ps1`：分级检测脚本，修改主进程/渲染层后可复用回归
- `restart.bat`：一键清理残留 Electron 进程并重启
