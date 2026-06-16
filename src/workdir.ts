/**
 * 共享工作目录 —— 供 executeCommandTool 和 /workdir 指令使用
 * 所有解析路径均被限制在工作区根目录（初始 cwd）及其子目录内
 */
import path from 'node:path';

// 工作区根目录 —— 初始为进程 cwd，但可通过 workdir-global 指令变更
// 保留原始引用用于 reset 恢复
const _originalWorkspaceRoot: string = process.cwd();
let _workspaceRoot: string = process.cwd();

let _cwd: string = process.cwd();

export function getCwd(): string {
  return _cwd;
}

export function setCwd(newCwd: string): string {
  _cwd = path.resolve(newCwd);
  return _cwd;
}

export function setWorkspaceRoot(newRoot: string): void {
  _workspaceRoot = path.resolve(newRoot);
}

export function resetWorkspaceRoot(): void {
  _workspaceRoot = _originalWorkspaceRoot;
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





