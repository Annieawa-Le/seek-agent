import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useElectronAPI } from '@/hooks/useElectronAPI.ts';

/**
 * 远程状态条：桌面端显示 RemoteBridge 的配对码 / 远程连接状态。
 *
 * 状态机（本地 state，保留最近一次事件）：
 *   - 未收到任何事件 → 返回 null（不渲染）
 *   - 收到 pair-code → 浅蓝白横条：大号配对码 + 有效期倒计时 + 复制按钮
 *   - 收到 status {connected:true} → 绿色横条「远程已连接」
 *   - 收到 status {connected:false} → 橙色横条「远程已断开」
 */
type RemoteView =
  | { kind: 'pair'; code: string }
  | { kind: 'connected' }
  | { kind: 'disconnected' };

const BAR_BG: Record<RemoteView['kind'], string> = {
  pair: '#eaf4fc', // 浅蓝白
  connected: '#e6f6e6', // 浅绿
  disconnected: '#fff3e0', // 浅橙
};

function barStyle(kind: RemoteView['kind']): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '14px',
    padding: '10px 16px',
    backgroundColor: BAR_BG[kind],
    color: kind === 'connected' ? '#1a7f37' : kind === 'disconnected' ? '#b45309' : '#333',
    fontSize: 14,
    fontWeight: kind === 'connected' || kind === 'disconnected' ? 600 : 400,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  };
}

export function RemoteStatusBar() {
  const api = useElectronAPI();
  /** 当前视图（最近一次事件决定；未收到事件为 null → 不渲染） */
  const [view, setView] = useState<RemoteView | null>(null);
  /** 配对码剩余秒数（从 expiresIn 开始每秒减 1；null=尚未开始，<=0 视为已过期） */
  const [remaining, setRemaining] = useState<number | null>(null);
  /** 复制后短暂显示「已复制」 */
  const [copied, setCopied] = useState(false);

  // 订阅配对码（remote:pair-code）
  useEffect(() => {
    const unsub = api.onRemotePairCode((data) => {
      setView({ kind: 'pair', code: data.code });
      setRemaining(data.expiresIn);
      setCopied(false);
    });
    return () => unsub();
  }, [api]);

  // 订阅远程连接状态（remote:status），覆盖/保留最近一次状态
  useEffect(() => {
    const unsub = api.onRemoteStatus((data) => {
      setView(data.connected ? { kind: 'connected' } : { kind: 'disconnected' });
    });
    return () => unsub();
  }, [api]);

  // 配对码有效期倒计时：每秒减 1，归零停表（显示「配对码已过期」）
  useEffect(() => {
    if (view?.kind !== 'pair') return;
    if (remaining === null || remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((r) => (r === null || r <= 0 ? r : r - 1)), 1000);
    return () => clearTimeout(timer);
  }, [view?.kind, remaining]);

  // 复制成功提示：1.5s 后恢复为「复制」
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  // 未收到任何远程事件：不渲染
  if (!view) return null;

  // 已连接
  // 已连接
  if (view.kind === 'connected') {
    return (
      <div style={barStyle('connected')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: '-2px' }}>
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        远程已连接
      </div>
    );
  }

  // 已断开
  if (view.kind === 'disconnected') {
    return (
      <div style={barStyle('disconnected')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: '-2px' }}>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        远程已断开
      </div>
    );
  }

  // 配对码：大号等宽 + 字间距 + 粗体；倒计时；复制按钮
  const expired = remaining !== null && remaining <= 0;
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(view.code);
      setCopied(true);
    } catch {
      /* 剪贴板不可用：静默 */
    }
  };

  return (
    <div style={barStyle('pair')}>
      <span
        style={{
          fontSize: 26,
          fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
          letterSpacing: 4,
          fontWeight: 700,
          color: '#1a5276',
        }}
      >
        {view.code}
      </span>
      <span style={{ fontSize: 13, color: '#666' }}>
        {expired ? (
          <span style={{ color: '#d33', fontWeight: 600 }}>配对码已过期</span>
        ) : (
          `有效期剩余 ${remaining}s`
        )}
      </span>
      <button
        onClick={handleCopy}
        style={{
          padding: '4px 14px',
          fontSize: 13,
          border: '1px solid #7fb3d8',
          borderRadius: 4,
          background: '#fff',
          color: '#1a5276',
          cursor: 'pointer',
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}


