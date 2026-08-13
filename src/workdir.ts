/**
 * 共享工作目录 —— 供 executeCommandTool 和 /workdir 指令使用
 * 所有解析路径均被限制在工作区根目录（初始 cwd）及其子目录内
 *
 * sessions 根（_sessionsRoot）与会话文件位置解耦：会话文件固定存应用根
 * ROOT/sessions（进程启动 cwd），运行时切换工作区（workdir-global）只改
 * workspaceRoot，不改 sessions 根——保证多会话各自工作区时会话文件全局可见。
 */
import path from 'node:path';

// 工作区根目录 —— 初始为进程 cwd，但可通过 workdir-global 指令变更
// 保留原始引用用于 reset 恢复
const _originalWorkspaceRoot: string = process.cwd();
let _workspaceRoot: string = process.cwd();

// sessions 根目录 —— 会话文件统一落点（初始 = 进程 cwd = 应用根）
let _sessionsRoot: string = process.cwd();

let _cwd: string = process.cwd();

export function getCwd(): string {
  return _cwd;
}

export function setCwd(newCwd: string): string {
  _cwd = path.resolve(newCwd);
  return _cwd;
}

/** 会话文件根目录（sessions/{sessionId}/... 的落点，固定应用根） */
export function getSessionsRoot(): string {
  return _sessionsRoot;
}

/** 显式设置会话文件根（仅测试/启动初始化用；生产保持进程启动 cwd） */
export function setSessionsRoot(root: string): void {
  _sessionsRoot = path.resolve(root);
}

/** 设置工作区根（同时同步 sessions 根，兼容测试的临时目录语义） */
export function setWorkspaceRoot(newRoot: string): void {
  _workspaceRoot = path.resolve(newRoot);
  _sessionsRoot = _workspaceRoot;
}

/** 运行时切换工作区（workdir-global 用）：只改工作区根，不动 sessions 根（会话文件固定应用根） */
export function setWorkspaceRootOnly(newRoot: string): void {
  _workspaceRoot = path.resolve(newRoot);
}

export function resetWorkspaceRoot(): void {
  _workspaceRoot = _originalWorkspaceRoot;
  _sessionsRoot = process.cwd();
}

export function getWorkspaceRoot(): string {
  return _workspaceRoot;
}

/** 校验绝对路径是否在工作区根目录下 */
export function assertPathInWorkspace(absolutePath: string): void {
  const rel = path.relative(_workspaceRoot, absolutePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径访问被拒绝：不允许访问工作区以外的路径 (${absolutePath})`);
  }
}

/** 将用户输入的路径（相对/绝对）解析为基于当前工作目录的绝对路径，并校验是否在工作区内 */
export function resolvePath(p: string): string {
  const resolved = path.resolve(_cwd, p);
  assertPathInWorkspace(resolved);
  return resolved;
}







