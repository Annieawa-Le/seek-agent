/**
 * 远程连接 Context：管理手机端（remote.html）到 Windows 端 seek-agent 的连接生命周期。
 *
 * 设计目标：去掉启动配对页，直接进主界面，通过左侧边栏按钮唤起连接窗口。
 * 本组件只负责「连接状态管理 + 注入 window.electronAPI」，不渲染任何 UI；
 * 连接窗口 UI 由 ConnectionPanel 负责。
 *
 * 逻辑移植自 remote-main.tsx 的 PairingPage：
 *   - URL 参数 ?relay=&code= 快速连接（有 code 自动发起一次，useRef 防重）；
 *   - connect() 调 createRemoteElectronAPI，配对成功注入 window.electronAPI + REMOTE_FLAG 标记；
 *   - disconnect() 调 transport 的断开方法并复位状态；Provider 卸载时自动断开。
 *
 * 信任 / 设备列表（手机端免密直连）：
 *   - 持久 deviceId（localStorage seekRemoteDeviceId）：本机唯一标识，随 auth 上报为 remoteId；
 *   - 设备列表（localStorage seekRemoteDevices）：已连接过的 Windows 设备，trusted 后可免密直连；
 *   - connect() 配对成功后自动保存设备；用户勾选「信任此设备」并填 Windows 设备 ID 时
 *     自动发 trust-request → 收 trust-granted → 更新设备为 trusted（免密直连可用）；
 *   - connectTrusted() 用已保存 token 免密直连；removeDevice() 删除；markTrusted() 手动补信任。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, JSX } from 'react';
import { createRemoteElectronAPI } from '../remote-transport/remote-electron-api.ts';
import type {
  ConnectionStatus,
  ElectronAPI as RemoteElectronAPI,
  SavedDevice,
  StatusInfo,
  TrustGrantedPayload,
  TrustRevokedPayload,
} from '../remote-transport/types.ts';

/** 连接状态机（与 remote-transport/types.ts 的 ConnectionStatus 同义） */
export type ConnStatus =
  | 'idle'
  | 'connecting'
  | 'paired'
  | 'need-repair'
  | 'peer-offline'
  | 'disconnected';

/** 码认证连接的附加选项（ConnectionPanel 传入；免密直连不需要） */
export interface ConnectOptions {
  /** Windows 端设备 id（relay 认证时上报的 deviceId）；免密直连必需 */
  relayDeviceId?: string;
  /** 配对成功后是否自动发 trust-request（需同时提供 relayDeviceId） */
  trust?: boolean;
  /** 设备显示名（缺省用中继地址） */
  label?: string;
}

export interface RemoteConnectionState {
  status: ConnStatus;
  statusMsg: string;
  relayUrl: string;
  code: string;
  paired: boolean; // 是否已配对成功（api 已可用）
  panelOpen: boolean;
  api: RemoteElectronAPI | null; // 配对成功后持有
  /** 本机持久 deviceId（remoteId），随 auth 上报 */
  deviceId: string;
  /** 已保存设备列表（localStorage 持久化） */
  devices: SavedDevice[];
  setRelayUrl: (v: string) => void;
  setCode: (v: string) => void;
  connect: (relay: string, code: string, opts?: ConnectOptions) => Promise<void>; // 配对；成功时内部处理注入与 setApi
  connectTrusted: (device: SavedDevice) => Promise<void>; // 免密直连（trusted 认证）
  removeDevice: (device: SavedDevice) => void; // 删除设备（尽力通知中继撤销信任）
  markTrusted: (device: SavedDevice, relayDeviceId?: string) => void; // 手动补信任（需已配对）
  disconnect: () => void; // 主动断开（调用 transport 断开方法 + 复位状态）
  openPanel: () => void;
  closePanel: () => void;
}

/** 注入标记：区分「transport 注入的 api」与「Electron preload 原生注入的 api」（remote-main.tsx 同款常量） */
export const REMOTE_FLAG = '__seekRemoteTransport';

export const RemoteConnectionContext = createContext<RemoteConnectionState | null>(null);

/**
 * 读取远程连接状态；返回 null 表示非远程模式（桌面 Electron 原生环境，无 Provider）。
 */
export function useRemoteConnection(): RemoteConnectionState | null {
  return useContext(RemoteConnectionContext);
}

/** 读取 URL 参数默认值（与 remote-main.tsx getUrlParams 相同逻辑） */
function getUrlParams(): { relay: string; code: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    relay: params.get('relay') || 'ws://localhost:8080',
    code: (params.get('code') || '').trim().toUpperCase(),
  };
}

/** 调用 transport 断开方法（api 上暴露 disconnect；close 为兜底） */
function disconnectTransport(api: RemoteElectronAPI | null): void {
  if (!api) return;
  const t = api as unknown as { disconnect?: () => void; close?: () => void };
  try {
    if (typeof t.disconnect === 'function') t.disconnect();
    else if (typeof t.close === 'function') t.close();
  } catch {
    /* 断开异常不影响状态复位 */
  }
}

// ---------------- 设备列表 / deviceId 工具 ----------------

const DEVICE_ID_KEY = 'seekRemoteDeviceId';
const DEVICES_KEY = 'seekRemoteDevices';

/** 读取或生成本机持久 deviceId（remoteId）；localStorage 不可用时回退会话级临时 id */
function getOrCreateDeviceId(): string {
  const fallback = () => `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : fallback();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return fallback();
  }
}

/** 读取设备列表（localStorage；异常 / 非数组时返回空） */
function loadDevices(): SavedDevice[] {
  try {
    const raw = localStorage.getItem(DEVICES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is SavedDevice => !!d && typeof (d as SavedDevice).relayUrl === 'string');
  } catch {
    return [];
  }
}

/** 判断两个设备是否同一台（relayDeviceId 已知时用它，否则用中继地址兜底） */
function sameDevice(a: SavedDevice, b: SavedDevice): boolean {
  if (a.relayDeviceId && b.relayDeviceId) return a.relayDeviceId === b.relayDeviceId;
  return a.relayUrl === b.relayUrl;
}

/** 合并设备：同 key 更新（浅合并），否则追加到末尾 */
function upsertDevice(list: SavedDevice[], dev: SavedDevice): SavedDevice[] {
  const idx = list.findIndex((d) => sameDevice(d, dev));
  if (idx >= 0) {
    const next = [...list];
    next[idx] = { ...next[idx], ...dev };
    return next;
  }
  return [...list, dev];
}

export function RemoteConnectionProvider({ children }: { children: ReactNode }): JSX.Element {
  const initial = getUrlParams();

  const [status, setStatus] = useState<ConnStatus>(initial.code ? 'connecting' : 'idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [relayUrl, setRelayUrl] = useState(initial.relay);
  const [code, setCode] = useState(initial.code);
  const [paired, setPaired] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [api, setApi] = useState<RemoteElectronAPI | null>(null);
  // 本机持久 deviceId：挂载时生成一次（惰性初始化，StrictMode 双跑也只会执行一次生成逻辑）
  const [deviceId] = useState<string>(getOrCreateDeviceId);
  const [devices, setDevices] = useState<SavedDevice[]>(loadDevices);

  // 当前 api 引用（disconnect / 卸载清理需要拿到最新值）
  const apiRef = useRef<RemoteElectronAPI | null>(null);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  // 设备列表持久化（localStorage）
  useEffect(() => {
    try {
      localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
    } catch {
      /* localStorage 不可用：仅内存态 */
    }
  }, [devices]);

  // URL 参数快速连接（?relay=...&code=...）只自动发起一次，useRef 防重
  const autoStartedRef = useRef(false);

  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);

  /** 构造 transport 共享回调：状态变化 + 信任授予 / 撤销（connect 与 connectTrusted 共用） */
  const makeTransportHandlers = useCallback((relay: string, label: string) => ({
    onStatusChange: (s: ConnectionStatus, info?: StatusInfo) => {
      setStatus(s as ConnStatus);
      setStatusMsg(info?.message || '');
    },
    onTrustGranted: (info: TrustGrantedPayload) => {
      setDevices(prev => upsertDevice(prev, {
        relayUrl: relay,
        relayDeviceId: info.relayDeviceId,
        remoteId: info.remoteId,
        token: info.token,
        label: info.label || label || relay,
        trusted: true,
        lastConnected: new Date().toISOString(),
      }));
    },
    onTrustRevoked: (info: TrustRevokedPayload) => {
      setDevices(prev => prev.map(d =>
        d.remoteId === info.remoteId && (!info.relayDeviceId || d.relayDeviceId === info.relayDeviceId)
          ? { ...d, trusted: false, token: '' }
          : d,
      ));
    },
  }), []);

  /** 配对成功后统一注入：electronAPI + REMOTE_FLAG 标记 + 持有 api + paired */
  const adoptApi = useCallback((newApi: RemoteElectronAPI): void => {
    const w = window as unknown as { electronAPI?: unknown };
    w.electronAPI = newApi;
    (newApi as unknown as Record<string, unknown>)[REMOTE_FLAG] = true;
    apiRef.current = newApi;
    setApi(newApi);
    setPaired(true);
    setPanelOpen(false);
  }, []);

  const connect = useCallback(async (relay: string, pairCode: string, opts?: ConnectOptions): Promise<void> => {
    const trimmedRelay = relay.trim();
    const trimmedCode = pairCode.trim().toUpperCase();
    if (!trimmedCode) return;
    setStatus('connecting');
    setStatusMsg('');
    setRelayUrl(trimmedRelay);
    setCode(trimmedCode);
    const label = opts?.label?.trim() || trimmedRelay;
    const rid = opts?.relayDeviceId?.trim() || '';
    try {
      const newApi = await createRemoteElectronAPI({
        relayUrl: trimmedRelay,
        code: trimmedCode,
        remoteId: deviceId,
        ...makeTransportHandlers(trimmedRelay, label),
      });
      // 配对成功：注入 api + 自动保存设备（trusted 状态由后续 trust-granted 更新）
      adoptApi(newApi);
      setDevices(prev => upsertDevice(prev, {
        relayUrl: trimmedRelay,
        relayDeviceId: rid,
        remoteId: deviceId,
        token: '',
        label,
        trusted: false,
        lastConnected: new Date().toISOString(),
      }));
      // 用户勾选「信任此设备」且已填 Windows 设备 ID：自动发 trust-request（失败不阻塞连接）
      if (opts?.trust && rid) {
        try {
          newApi.sendTrustRequest(rid, deviceId, label);
        } catch {
          /* 信任失败不影响已建立的连接 */
        }
      }
    } catch (err) {
      // auth 失败：onStatusChange 已置 need-repair；这里兜底展示错误并允许重新输入
      setStatusMsg(err instanceof Error ? err.message : '连接失败');
    }
  }, [adoptApi, deviceId, makeTransportHandlers]);

  /** 免密直连：用已保存的 trusted 凭证认证（免输码） */
  const connectTrusted = useCallback(async (device: SavedDevice): Promise<void> => {
    setStatus('connecting');
    setStatusMsg('');
    setRelayUrl(device.relayUrl);
    setCode('');
    try {
      const newApi = await createRemoteElectronAPI({
        relayUrl: device.relayUrl,
        trusted: {
          relayDeviceId: device.relayDeviceId,
          remoteId: device.remoteId,
          token: device.token,
        },
        remoteId: device.remoteId,
        ...makeTransportHandlers(device.relayUrl, device.label),
      });
      adoptApi(newApi);
      // 更新上次连接时间
      setDevices(prev => prev.map(d => sameDevice(d, device) ? { ...d, lastConnected: new Date().toISOString() } : d));
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : '免密直连失败');
    }
  }, [adoptApi, makeTransportHandlers]);

  /** 删除设备：当前已配对且该设备已信任时尽力通知中继撤销信任（失败不影响本地删除） */
  const removeDevice = useCallback((device: SavedDevice): void => {
    const cur = apiRef.current;
    if (cur && device.relayDeviceId && device.remoteId) {
      try {
        cur.sendTrustRevoke(device.relayDeviceId, device.remoteId);
      } catch {
        /* ignore */
      }
    }
    setDevices(prev => prev.filter(d => !sameDevice(d, device)));
  }, []);

  /** 手动补信任：需当前已配对（transport 连着目标中继）且知道 Windows 设备 ID；结果由 trust-granted 更新 */
  const markTrusted = useCallback((device: SavedDevice, relayDeviceId?: string): void => {
    const cur = apiRef.current;
    if (!cur) return;
    const rid = (relayDeviceId ?? device.relayDeviceId).trim();
    if (!rid) return;
    try {
      cur.sendTrustRequest(rid, device.remoteId || deviceId, device.label || device.relayUrl);
    } catch {
      /* ignore */
    }
  }, [deviceId]);

  // URL 参数自动连接一次
  useEffect(() => {
    const params = getUrlParams();
    if (params.code && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void connect(params.relay, params.code);
    }
  }, [connect]);

  const disconnect = useCallback(() => {
    disconnectTransport(apiRef.current);
    apiRef.current = null;
    setApi(null);
    setPaired(false);
    setStatus('disconnected');
    setStatusMsg('');
  }, []);

  // 卸载时清理：断开当前 transport（Provider 卸载时如果有 api 调 disconnect）
  useEffect(() => {
    return () => {
      disconnectTransport(apiRef.current);
      apiRef.current = null;
    };
  }, []);

  const value = useMemo<RemoteConnectionState>(() => ({
    status,
    statusMsg,
    relayUrl,
    code,
    paired,
    panelOpen,
    api,
    deviceId,
    devices,
    setRelayUrl,
    setCode,
    connect,
    connectTrusted,
    removeDevice,
    markTrusted,
    disconnect,
    openPanel,
    closePanel,
  }), [status, statusMsg, relayUrl, code, paired, panelOpen, api, deviceId, devices, setRelayUrl, setCode, connect, connectTrusted, removeDevice, markTrusted, disconnect, openPanel, closePanel]);

  return <RemoteConnectionContext.Provider value={value}>{children}</RemoteConnectionContext.Provider>;
}


