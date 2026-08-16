/**
 * 共享工作目录 —— 供 executeCommandTool 和 /workdir 指令使用
 * 所有解析路径均被限制在工作区根目录（初始 cwd）及其子目录内
 *
 * 支持多工作区：_workspaceRoots 为已挂载的工作区根列表，_workspaceRoot 为
 * 当前活跃根（execute_command 的 cwd、virtual-explorer 根、prompt 展示均指向它）；
 * 沙箱放行任意已挂载根下的路径访问。
 *
 * sessions 根（_sessionsRoot）与会话文件位置解耦：会话文件固定存应用根
 * ROOT/sessions（进程启动 cwd），运行时切换工作区（workdir-global / workdir-roots）只改
 * workspaceRoot，不改 sessions 根——保证多会话各自工作区时会话文件全局可见。
 */
import path from 'node:path';

// 工作区根列表 —— 初始为进程 cwd，可通过 workdir-roots 指令整体设置
// 保留原始引用用于 reset 恢复
const _originalWorkspaceRoot: string = process.cwd();
let _workspaceRoots: string[] = [process.cwd()];
// 当前活跃工作区根（始终是 _workspaceRoots 中的一项）
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
  _workspaceRoots = [_workspaceRoot];
  _sessionsRoot = _workspaceRoot;
}

/** 运行时切换工作区（workdir-global 用）：只改工作区根，不动 sessions 根（会话文件固定应用根） */
export function setWorkspaceRootOnly(newRoot: string): void {
  _workspaceRoot = path.resolve(newRoot);
  _workspaceRoots = [_workspaceRoot];
}

/**
 * 运行时设置多工作区根列表（workdir-roots 用）：整体替换已挂载根，并指定活跃根。
 * 只改工作区根，不动 sessions 根。roots 为空时回退到当前活跃根。
 */
export function setWorkspaceRootsOnly(roots: string[], active?: string): void {
  _workspaceRoots = (roots.length > 0 ? roots : [_workspaceRoot]).map(r => path.resolve(r));
  _workspaceRoot = active ? path.resolve(active) : _workspaceRoots[0];
  // 活跃根必须在列表内，否则回退到第一个
  if (!_workspaceRoots.includes(_workspaceRoot)) {
    _workspaceRoot = _workspaceRoots[0];
  }
}

export function resetWorkspaceRoot(): void {
  _workspaceRoot = _originalWorkspaceRoot;
  _workspaceRoots = [_workspaceRoot];
  _sessionsRoot = process.cwd();
}

/** 已挂载的工作区根列表（副本） */
export function getWorkspaceRoots(): string[] {
  return [..._workspaceRoots];
}

/** 当前活跃工作区根 */
export function getWorkspaceRoot(): string {
  return _workspaceRoot;
}

/** 校验绝对路径是否在任一已挂载工作区根下 */
export function assertPathInWorkspace(absolutePath: string): void {
  for (const root of _workspaceRoots) {
    const rel = path.relative(root, absolutePath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return;
  }
  throw new Error(`路径访问被拒绝：不允许访问工作区以外的路径 (${absolutePath})`);
}

/** 将用户输入的路径（相对/绝对）解析为基于当前工作目录的绝对路径，并校验是否在工作区内 */
export function resolvePath(p: string): string {
  const resolved = path.resolve(_cwd, p);
  assertPathInWorkspace(resolved);
  return resolved;
}
















