import type { AgentMessage, AgentStatus, CollabLogEntry, CollabSession, FileTreeNode, GitChange, IdentityCard, SessionInfo } from '@/types/index.ts';
import { useEffect, useRef, useCallback, useMemo } from 'react';

export function isElectron(): boolean {
  return !!window.electronAPI;
}

export function useElectronAPI() {
  const api = window.electronAPI;
  const listenersRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    return () => {
      listenersRef.current.forEach(fn => fn());
      listenersRef.current = [];
    };
  }, []);

  const onMessage = useCallback((cb: (msg: AgentMessage) => void) => {
    if (!api) return () => {};
    const unsub = api.onAgentMessage(cb);
    listenersRef.current.push(unsub);
    return unsub;
  }, [api]);

  const onStatus = useCallback((cb: (status: AgentStatus) => void) => {
    if (!api) return () => {};
    const unsub = api.onAgentStatus(cb);
    listenersRef.current.push(unsub);
    return unsub;
  }, [api]);

  const onStderr = useCallback((cb: (text: string) => void) => {
    if (!api) return () => {};
    const unsub = api.onAgentStderr(cb);
    listenersRef.current.push(unsub);
    return unsub;
  }, [api]);

  const onWorkdirChanged = useCallback((cb: (path: string) => void) => {
    if (!api) return () => {};
    const unsub = api.onWorkdirChanged(cb);
    listenersRef.current.push(unsub);
    return unsub;
  }, [api]);

  const sendInput = useCallback((content: string) => {
    api?.sendInput(content);
  }, [api]);

  const sendCommand = useCallback((cmd: string) => {
    api?.sendCommand(cmd);
  }, [api]);

  const abort = useCallback(() => {
    api?.abort();
  }, [api]);

  const restart = useCallback(() => {
    api?.restart();
  }, [api]);

  const getWorkdir = useCallback(async (): Promise<string> => {
    if (!api) return '';
    return api.getWorkdir();
  }, [api]);

  const setWorkdir = useCallback(async (dirPath: string) => {
    if (!api) return { error: 'API 不可用' };
    return api.setWorkdir(dirPath);
  }, [api]);

  const getSkillsList = useCallback(async (): Promise<Array<{ name: string; description: string }>> => {
    if (!api) return [];
    return api.getSkillsList();
  }, [api]);

  const openFileDialog = useCallback(async () => {
    if (!api) return { canceled: true, files: [] };
    return api.openFileDialog();
  }, [api]);

  const selectFolder = useCallback(async () => {
    if (!api) return { canceled: true };
    return api.selectFolder();
  }, [api]);

  const getRecentDirs = useCallback(async (): Promise<string[]> => {
    if (!api) return [];
    return api.getRecentDirs();
  }, [api]);

  const getAgentStatus = useCallback(async () => {
    if (!api) return { connected: false };
    return api.getAgentStatus();
  }, [api]);

  const readFileTree = useCallback(async (dirPath = '') => {
    if (!api) return [];
    return api.readFileTree(dirPath);
  }, [api]);

  const readGitStatus = useCallback(async (): Promise<GitChange[]> => {
    if (!api) return [];
    return api.readGitStatus();
  }, [api]);

  const listSessions = useCallback(async (): Promise<SessionInfo[]> => {
    if (!api) return [];
    return api.listSessions();
  }, [api]);

  const generateIdentityCard = useCallback(async (sessionId?: string) => {
    if (!api) return { error: 'API 不可用' };
    return api.generateIdentityCard(sessionId);
  }, [api]);

  const onIdentityCard = useCallback((cb: (data: { sessionId: string; card?: IdentityCard; error?: string }) => void) => {
    if (!api) return () => {};
    const unsub = api.onIdentityCard(cb);
    listenersRef.current.push(unsub);
    return unsub;
  }, [api]);

  const onCollabEvent = useCallback((cb: (data: { type: string }) => void) => {
    if (!api) return () => {};
    const unsub = api.onCollabEvent(cb);
    listenersRef.current.push(unsub);
    return unsub;
  }, [api]);

  const onSessionError = useCallback((cb: (data: { sessionId: string; error: string }) => void) => {
    if (!api) return () => {};
    const unsub = api.onSessionError(cb);
    listenersRef.current.push(unsub);
    return unsub;
  }, [api]);


  const getCollabSessions = useCallback(async () => {
    if (!api) return [];
    return api.getCollabSessions();
  }, [api]);

  const getCollabLog = useCallback(async () => {
    if (!api) return [];
    return api.getCollabLog();
  }, [api]);



  // ─── 多会话控制 ───

  const switchSession = useCallback(async (sessionId: string, name?: string) => {
    if (!api) return { error: 'API 不可用' };
    return api.switchSession(sessionId, name);
  }, [api]);

  const newSession = useCallback(async () => {
    if (!api) return { error: 'API 不可用' };
    return api.newSession();
  }, [api]);

  const closeSession = useCallback(async (sessionId: string) => {
    if (!api) return { error: 'API 不可用' };
    return api.closeSession(sessionId);
  }, [api]);

  const getCurrentSession = useCallback(async () => {
    if (!api) return { sessionId: 'default' };
    return api.getCurrentSession();
  }, [api]);

  const listActiveSessions = useCallback(async () => {
    if (!api) return [];
    return api.listActiveSessions();
  }, [api]);

  // ─── 侧边栏数据 ───

  const getSidebarStatic = useCallback(async () => {
    if (!api) return { skills: [], instructions: [], addonAgents: [], mcpConfig: [] };
    return api.getSidebarStatic();
  }, [api]);

  const readInstruction = useCallback(async (kind: string, file: string) => {
    if (!api) return { error: 'API 不可用' };
    return api.readInstruction(kind, file);
  }, [api]);

  const onMaximizedChange = useCallback((cb: (isMaximized: boolean) => void) => {
    if (!api) return () => {};
    const unsub = api.onMaximizedChange(cb);
    listenersRef.current.push(unsub);
    return unsub;
  }, [api]);

  const minimizeWindow = useCallback(() => {
    api?.minimizeWindow();
  }, [api]);

  const maximizeWindow = useCallback(() => {
    api?.maximizeWindow();
  }, [api]);

  const closeWindow = useCallback(() => {
    api?.closeWindow();
  }, [api]);

  const isWindowMaximized = useCallback(async (): Promise<boolean> => {
    if (!api) return false;
    return api.isMaximized();
  }, [api]);
  // api 对象本身（preload contextBridge 暴露）是稳定的；
  // useMemo 保证返回的包裹对象引用稳定，避免 useCallback(…, [api]) 每次渲染失效导致 useEffect 无限重跑
  return useMemo(() => ({

    isAvailable: !!api,
    onMessage,
    onStatus,
    getAgentStatus,
    onStderr,
    onWorkdirChanged,
    sendInput,
    sendCommand,
    abort,
    restart,
    getWorkdir,
    setWorkdir,
    selectFolder,
    openFileDialog,
    getRecentDirs,
    readFileTree,
    readGitStatus,
    listSessions,
    generateIdentityCard,
    onIdentityCard,
    onCollabEvent,
    onSessionError,
    getCollabSessions,
    getCollabLog,
    getSkillsList,
    switchSession,
    newSession,
    closeSession,
    getCurrentSession,
    listActiveSessions,
    getSidebarStatic,
    readInstruction,
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    isWindowMaximized,
    onMaximizedChange,
  }), [api]);
}




















