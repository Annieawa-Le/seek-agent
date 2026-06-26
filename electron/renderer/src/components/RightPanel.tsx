import { useState, useEffect, useCallback } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';
import type { FileTreeNode, GitChange } from '@/types/index.ts';

const tagClassMap: Record<string, string> = { js: 'tag-yellow', ts: 'tag-blue', json: 'tag-yellow', npm: 'tag-red', mjs: 'tag-yellow', cjs: 'tag-yellow' };
const tagLabelMap: Record<string, string> = { json: '{}', npmrc: 'npm' };

export function RightPanel() {
  const { readFileTree, readGitStatus } = useElectronAPI();
  const [currentTab, setCurrentTab] = useState<'files' | 'changes'>('files');
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [gitChanges, setGitChanges] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(false);

  const loadFileTree = useCallback(async () => {
    setLoading(true);
    const data = await readFileTree('');
    if (Array.isArray(data)) setFileTree(data);
    setLoading(false);
  }, [readFileTree]);

  const loadGitChanges = useCallback(async () => {
    setLoading(true);
    const data = await readGitStatus();
    if (Array.isArray(data)) setGitChanges(data);
    setLoading(false);
  }, [readGitStatus]);

  useEffect(() => {
    if (currentTab === 'files') loadFileTree();
    else loadGitChanges();
  }, [currentTab, loadFileTree, loadGitChanges]);

  return (
    <aside id="info-panel">
      <div className="panel-tabs">
        <span className={`panel-tab${currentTab === 'changes' ? '' : ' active'}`} onClick={() => setCurrentTab('files')}>Files</span>
        <span className={`panel-tab${currentTab === 'changes' ? ' active' : ''}`} onClick={() => setCurrentTab('changes')}>Changes</span>
        <div className="panel-tab-actions">
          <button className="panel-tab-btn" title="搜索"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
          <button className="panel-tab-btn" title="面板布局"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
        </div>
      </div>
      <div id="panel-content">
        {loading ? <div className="file-tree-loading">加载中…</div>
          : currentTab === 'files' ? <FileTreeContent nodes={fileTree} />
          : <GitChangesContent changes={gitChanges} />}
      </div>
    </aside>
  );
}

function FileTreeContent({ nodes }: { nodes: FileTreeNode[] }) {
  if (nodes.length === 0) return <div className="panel-empty">项目为空</div>;
  return <div className="file-tree"><TreeNodes nodes={nodes} /></div>;
}

function TreeNodes({ nodes }: { nodes: FileTreeNode[] }) {
  return <>
    {nodes.map(node =>
      node.type === 'folder' ? <FolderNode key={node.path} node={node} />
        : (
          <div key={node.path} className="tree-item file" data-path={node.path}>
            {tagClassMap[node.ext || ''] ? <span className={`tree-tag ${tagClassMap[node.ext || '']}`}>{(tagLabelMap[node.ext || ''] || node.ext || '').toUpperCase()}</span>
              : <span className="tree-icon">≡</span>}
            <span className="tree-name">{node.name}</span>
          </div>
        )
    )}
  </>;
}

function FolderNode({ node }: { node: FileTreeNode }) {
  const [expanded, setExpanded] = useState(false);
  return <>
    <div className="tree-item folder" onClick={() => setExpanded(v => !v)}>
      <span className="tree-toggle">{expanded ? '▼' : '▶'}</span>
      <span className="tree-folder-icon">📁</span>
      <span className="tree-name">{node.name}</span>
    </div>
    {expanded && node.children && <div className="tree-children"><TreeNodes nodes={node.children} /></div>}
  </>;
}

const statusClassMap: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed' };

function GitChangesContent({ changes }: { changes: GitChange[] }) {
  if (changes.length === 0) return <div className="panel-empty">工作区干净，无变更</div>;
  return <div className="changes-list">
    {changes.map((ch, i) => (
      <div key={i} className={`change-item ${statusClassMap[ch.status] || 'untracked'}`} title={ch.file}>
        <span className="change-status">{ch.status}</span>
        <span className="change-file">{ch.file}</span>
      </div>
    ))}
  </div>;
}


