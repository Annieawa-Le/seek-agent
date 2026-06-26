import { useEffect, useRef, useCallback } from 'react';
import type { AgentMessage, AgentStatus, FileTreeNode, GitChange, SessionInfo } from '@/types/index.ts';

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
  return {
    isAvailable: !!api,
    onMessage,
    onStatus,
    onStderr,
    sendInput,
    sendCommand,
    abort,
    restart,
    readFileTree,
    readGitStatus,
    listSessions,
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    isWindowMaximized,
    onMaximizedChange,
  };
}





