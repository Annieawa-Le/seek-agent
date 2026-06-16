/**
 * explorer-state — virtual-explorer 的共享状态
 *
 * 维护两个层次：
 *   - explorerRoot（根目录）：可通过 /workdir-global 指令修改
 *   - explorerPath（当前位置）：在根目录下导航
 *
 * 起始点锚定在工作区根目录，explorerGoUp 不会超出根目录。
 */
import { getWorkspaceRoot } from '../../../workdir.js';

let _explorerRoot: string = getWorkspaceRoot();
let _explorerPath: string = _explorerRoot;

export function getExplorerRoot(): string {
  return _explorerRoot;
}

export function setExplorerRoot(p: string): void {
  _explorerRoot = p;
}

export function resetExplorerRoot(): void {
  _explorerRoot = getWorkspaceRoot();
}

export function getExplorerPath(): string {
  return _explorerPath;
}

export function setExplorerPath(p: string): void {
  _explorerPath = p;
}

/** 重置当前位置到根目录（不改变根目录本身） */
export function resetExplorerPath(): void {
  _explorerPath = _explorerRoot;
}
