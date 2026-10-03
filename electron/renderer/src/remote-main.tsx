/**
 * seek-agent 远程模式入口（remote.html 使用）
 *
 * 在浏览器 / Capacitor WebView 中打开时：
 *   1. 若 window.electronAPI 已存在且非本 transport 注入（即 Electron 环境 / preload 原生注入），
 *      跳过配对，直接挂载主 App（防误用；remote.html 一般只在浏览器/WebView 打开）；
 *   2. 否则进入远程模式：RemoteConnectionProvider 管理连接生命周期，
 *      直接挂载主 App（不再先配对页），左侧边栏「连接远程」按钮唤起连接面板；
 *      配对成功后 Provider 注入 window.electronAPI + REMOTE_FLAG 标记，RemoteShell 中
 *      key 变化强制 App 重挂载，useElectronAPI 重新读到 api → 正常进入会话。
 *
 * 与 main.tsx 唯一差异：远程连接由 Provider 管理（App 组件复用 + 未连接占位）。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import '@/style.css';
import { RemoteConnectionProvider, REMOTE_FLAG, useRemoteConnection } from './components/RemoteConnectionContext.tsx';
import { ConnectionPanel } from './components/ConnectionPanel.tsx';
import type { ElectronAPI as RemoteElectronAPI } from './remote-transport/types.ts';
import type { ElectronAPI as RendererElectronAPI } from '@/types/index.ts';

/**
 * 编译期形状校验：renderer 契约（RendererElectronAPI，types/index.ts）的全部方法，
 * transport 同形接口（RemoteElectronAPI，remote-transport/types.ts）均已实现。
 *   transport 的 sendInput/sendCommand/abort/restart 返回 Promise、
 *   openFileDialog.files 可选等，
 *   均与 useElectronAPI 的实际调用方式兼容——hook 不依赖这些返回值/可选性。）
 */
type AssertCoverage<Contract, Impl> = keyof Contract extends keyof Impl ? true : never;
const _shapeOk: AssertCoverage<RendererElectronAPI, RemoteElectronAPI> = true;
/** 远程模式外壳：Provider 内渲染 App（未连接时显示占位）+ 连接面板 */
function RemoteShell() {
  const conn = useRemoteConnection();
  // 配对成功后 Provider 已注入 window.electronAPI；key 变化强制 App 重挂载，useElectronAPI 重新读 api
  return (
    <>
      <App key={conn?.paired ? 'remote-connected' : 'remote-boot'} />
      <ConnectionPanel />
    </>
  );
}

/** 远程模式引导：Electron 原生环境直接挂载 App；否则 Provider 管理连接，App 始终渲染 */
function RemoteBootstrap() {
  const existing = (window as unknown as { electronAPI?: unknown }).electronAPI;
  const skipPairing = !!existing && !(existing as Record<string, unknown>)[REMOTE_FLAG];
  if (skipPairing) {
    // Electron 原生环境：不走 transport，直接 App（保持原行为）
    return <App />;
  }
  // 远程模式：Provider 管理连接，App 始终渲染，连接面板由侧边栏按钮唤起
  return (
    <RemoteConnectionProvider>
      <RemoteShell />
    </RemoteConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RemoteBootstrap />
  </React.StrictMode>,
);
/**
 * 远程模式下，DOM 注入型扩展的宿主地址由宿主端（配对后随能力清单下发）提供。
 * 这里只做 API 形状补全——内容扩展点自身「无宿主即不生效」，不影响远程模式原有行为。
 */
declare global {
  interface Window {
    /** 由远程 transport 在配对成功后注入的本地扩展宿主根地址（未注入 = 无扩展宿主） */
    __SEEK_EXT_HOST?: string;
  }
}








