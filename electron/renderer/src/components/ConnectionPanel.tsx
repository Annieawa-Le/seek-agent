/**
 * 远程连接面板：美化版连接窗口（替代旧 PairingPage 的 UI），移动端底部抽屉风格，桌面浏览器也可用。
 *
 * - 通过 useRemoteConnection() 取状态；context 为 null（桌面 Electron 原生环境）或面板未打开时不渲染。
 * - 已连接（paired）：绿色大号状态 + 中继地址 + 断开按钮；
 * - 未连接：中继地址 + 配对码（6 位大写自动转大写）+ 「信任此设备」选项 + 连接主按钮 + 状态/错误文案。
 * - 已保存设备列表：顶部展示已信任（免密直连）与未信任设备卡片，点击连接、× 删除、未信任可补信任。
 * - 关闭：遮罩点击（target===currentTarget）、× 按钮、ESC 键。
 */
import { useEffect, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import { useRemoteConnection } from './RemoteConnectionContext.tsx';
import type { ConnStatus } from './RemoteConnectionContext.tsx';
import type { SavedDevice } from '../remote-transport/types.ts';

/** 状态徽章：小圆点 + 文字（idle=灰 / connecting=蓝 / paired=绿 / need-repair=橙 / peer-offline=灰 / disconnected=灰） */
const BADGE: Record<ConnStatus, { dot: string; text: string; bg: string; label: string }> = {
  idle: { dot: '#8c8c8c', text: '#595959', bg: '#f0f2f5', label: '未连接' },
  connecting: { dot: '#3370ff', text: '#3370ff', bg: '#e8f0ff', label: '连接中…' },
  paired: { dot: '#2e7d32', text: '#2e7d32', bg: '#e6f6e6', label: '已连接' },
  'need-repair': { dot: '#fa8c16', text: '#d4380d', bg: '#fff3e0', label: '需重新配对' },
  'peer-offline': { dot: '#8c8c8c', text: '#595959', bg: '#f0f2f5', label: '对端离线' },
  disconnected: { dot: '#8c8c8c', text: '#595959', bg: '#f0f2f5', label: '已断开' },
};

/** 上次连接时间 → 友好文案（刚刚 / N 分钟前 / N 小时前 / 日期） */
function formatTime(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(t).toLocaleDateString();
}

export function ConnectionPanel(): JSX.Element | null {
  const conn = useRemoteConnection();
  // focus 边框主色（内联样式无法表达 :focus，用 onFocus/onBlur 切换）
  const [focusKey, setFocusKey] = useState<'relay' | 'code' | 'winid' | null>(null);
  // 「信任此设备」：勾选 + Windows 设备 ID（配对成功后自动发 trust-request）
  const [trustThis, setTrustThis] = useState(false);
  const [winDeviceId, setWinDeviceId] = useState('');

  // ESC 键关闭
  useEffect(() => {
    const cp = conn?.closePanel;
    if (!cp) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cp();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [conn]);

  // context 为 null（非远程模式）或面板未打开：不渲染
  if (!conn || !conn.panelOpen) return null;

  const { status, statusMsg, relayUrl, code, paired, api, devices, setRelayUrl, setCode, connect, connectTrusted, removeDevice, markTrusted, disconnect, closePanel } = conn;

  const busy = status === 'connecting';
  const badge = BADGE[status];

  // 对端 deviceId（transport api 有提供则显示，无则省略）
  const deviceId = (api as unknown as { deviceId?: string } | null)?.deviceId;

  /** 已保存设备卡片点击：已信任 → 免密直连；未信任 → 填入中继地址走码连接流程 */
  const handleDeviceClick = (d: SavedDevice): void => {
    if (d.trusted && d.relayDeviceId && d.token) {
      void connectTrusted(d);
    } else {
      setRelayUrl(d.relayUrl);
      setTrustThis(false);
      setWinDeviceId('');
      setCode('');
    }
  };

  // focus 边框主色（内联样式无法表达 :focus，用 onFocus/onBlur 切换）
  const inputStyle = (focused: boolean): CSSProperties => ({
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    marginTop: 6,
    padding: '12px 12px',
    fontSize: 15,
    border: `1px solid ${focused ? '#3370ff' : '#d0d3d6'}`,
    borderRadius: 10,
    outline: 'none',
    fontFamily: 'inherit',
    color: '#1f2329',
    background: '#fff',
  });

  return (
    <>
      <style>{`
        @keyframes cp-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes cp-slide-up { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          zIndex: 1000,
          display: 'flex',
          alignItems: 'flex-end', // 移动端优先：底部抽屉
          justifyContent: 'center',
          animation: 'cp-fade-in 0.18s ease-out',
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) closePanel();
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 560,
            margin: '0 auto',
            background: '#fff',
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            boxShadow: '0 -4px 32px rgba(0,0,0,0.18)',
            padding: '20px 20px calc(20px + env(safe-area-inset-bottom))',
            maxHeight: '85vh',
            overflowY: 'auto',
            boxSizing: 'border-box',
            animation: 'cp-slide-up 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        >
          {/* 标题 + 关闭按钮 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: '#1f2329' }}>远程连接</div>
            <button
              type="button"
              aria-label="关闭"
              onClick={closePanel}
              style={{
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 22,
                color: '#8c8c8c',
                lineHeight: 1,
                padding: '2px 6px',
              }}
            >×</button>
          </div>

          {/* 状态徽章：小圆点 + 文字 */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 12px', borderRadius: 999, background: badge.bg, marginBottom: 18 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: badge.dot, display: 'inline-block' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: badge.text }}>{badge.label}</span>
          </div>

          {/* 已保存设备列表（若有） */}
          {devices.length > 0 ? (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#595959', marginBottom: 8 }}>已保存设备（{devices.length}）</div>
              {devices.map((d, i) => (
                <div
                  key={d.relayDeviceId || `${d.relayUrl}-${i}`}
                  onClick={() => handleDeviceClick(d)}
                  style={{
                    border: '1px solid #e5e6eb',
                    borderRadius: 12,
                    padding: '10px 12px',
                    marginBottom: 8,
                    cursor: 'pointer',
                    background: '#fafafa',
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#3370ff'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#e5e6eb'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2329', wordBreak: 'break-all' }}>
                        {d.label || d.relayUrl}
                      </div>
                      <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 3, wordBreak: 'break-all' }}>
                        中继：{d.relayUrl}
                      </div>
                      <div style={{ fontSize: 12, color: '#b0b3b8', marginTop: 2 }}>
                        上次连接：{formatTime(d.lastConnected) || '从未'}
                        {d.relayDeviceId ? ` · ID:${d.relayDeviceId}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      {/* 信任徽章 */}
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: 999,
                          whiteSpace: 'nowrap',
                          color: d.trusted ? '#2e7d32' : '#8c8c8c',
                          background: d.trusted ? '#e6f6e6' : '#f0f2f5',
                        }}
                      >
                        {d.trusted ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
                            已信任
                          </span>
                        ) : '未信任'}
                      </span>
                      <button
                        type="button"
                        aria-label="删除设备"
                        title="删除设备"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeDevice(d);
                        }}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          fontSize: 16,
                          color: '#b0b3b8',
                          lineHeight: 1,
                          padding: '2px 6px',
                        }}
                      >×</button>
                    </div>
                  </div>
                  {/* 未信任 + 已知道 Windows 设备 ID + 当前已配对：可手动补信任 */}
                  {!d.trusted && d.relayDeviceId && paired ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        markTrusted(d);
                      }}
                      style={{
                        marginTop: 8,
                        padding: '5px 12px',
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#3370ff',
                        background: '#e8f0ff',
                        border: 'none',
                        borderRadius: 8,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >补信任（免密直连）</button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: '#b0b3b8', marginBottom: 18, padding: '2px 0' }}>
              暂无已保存设备 — 配对成功后会自动保存，之后可免密直连。
            </div>
          )}

          {paired ? (
            /* ---------- 已连接：绿色大号状态 + 中继地址 + 断开 ---------- */
            <div style={{ textAlign: 'center', padding: '10px 0 4px' }}>
              <svg
                width="52"
                height="52"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#2e7d32"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: 'block', margin: '0 auto 10px' }}
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="16 8.5 10.5 15 8 12.5" />
              </svg>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#2e7d32' }}>已连接</div>
              <div style={{ fontSize: 13, color: '#8c8c8c', marginTop: 10, wordBreak: 'break-all' }}>中继：{relayUrl}</div>
              {deviceId ? (
                <div style={{ fontSize: 13, color: '#8c8c8c', marginTop: 4, wordBreak: 'break-all' }}>对端设备：{deviceId}</div>
              ) : null}
              <button
                type="button"
                onClick={disconnect}
                style={{
                  marginTop: 22,
                  padding: '10px 34px',
                  fontSize: 15,
                  fontWeight: 600,
                  color: '#d93026',
                  background: '#fff',
                  border: '1px solid #ffa39e',
                  borderRadius: 10,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >断开</button>
            </div>
          ) : (
            /* ---------- 未连接：中继地址 + 配对码 + 信任选项 + 连接 + 状态文案 ---------- */
            <div>
              <label style={{ display: 'block', marginBottom: 14, fontSize: 13, color: '#646a73' }}>
                中继地址
                <input
                  style={inputStyle(focusKey === 'relay')}
                  value={relayUrl}
                  onChange={(e) => setRelayUrl(e.target.value)}
                  onFocus={() => setFocusKey('relay')}
                  onBlur={() => setFocusKey(null)}
                  placeholder="ws://localhost:8080"
                  disabled={busy}
                  spellCheck={false}
                />
              </label>
              <label style={{ display: 'block', marginBottom: 14, fontSize: 13, color: '#646a73' }}>
                配对码（6 位）
                <input
                  style={inputStyle(focusKey === 'code')}
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  onFocus={() => setFocusKey('code')}
                  onBlur={() => setFocusKey(null)}
                  placeholder="如 ABC123"
                  maxLength={6}
                  disabled={busy}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </label>

              {/* 信任此设备：配对成功后自动互信，免密直连 */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: trustThis ? 12 : 18, fontSize: 13, color: '#595959', cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={trustThis}
                  onChange={(e) => setTrustThis(e.target.checked)}
                  disabled={busy}
                  style={{ width: 16, height: 16, accentColor: '#3370ff', cursor: 'pointer' }}
                />
                <span>配对成功后信任此设备（免密直连）</span>
              </label>
              {trustThis ? (
                <label style={{ display: 'block', marginBottom: 18, fontSize: 13, color: '#646a73' }}>
                  Windows 设备 ID
                  <input
                    style={inputStyle(focusKey === 'winid')}
                    value={winDeviceId}
                    onChange={(e) => setWinDeviceId(e.target.value.trim())}
                    onFocus={() => setFocusKey('winid')}
                    onBlur={() => setFocusKey(null)}
                    placeholder="在 Windows 端设备面板查看（如 seek-win-8f3a）"
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span style={{ display: 'block', marginTop: 6, fontSize: 12, color: '#b0b3b8' }}>
                    用于生成信任凭证；配对成功后即可免密直连
                  </span>
                </label>
              ) : null}

              <button
                type="button"
                onClick={() => void connect(relayUrl, code, { relayDeviceId: trustThis ? winDeviceId : undefined, trust: trustThis })}
                disabled={busy || !code.trim() || (trustThis && !winDeviceId.trim())}
                style={{
                  width: '100%',
                  padding: '13px',
                  fontSize: 16,
                  fontWeight: 600,
                  color: '#fff',
                  background: '#3370ff',
                  border: 'none',
                  borderRadius: 10,
                  cursor: busy || !code.trim() || (trustThis && !winDeviceId.trim()) ? 'not-allowed' : 'pointer',
                  opacity: busy || !code.trim() || (trustThis && !winDeviceId.trim()) ? 0.6 : 1,
                  fontFamily: 'inherit',
                }}
              >{busy ? '连接中…' : '连接'}</button>

              {/* 状态 / 错误文案 */}
              {statusMsg ? (
                <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6, color: status === 'need-repair' ? '#d4380d' : '#8c8c8c' }}>{statusMsg}</div>
              ) : null}
              {status === 'need-repair' && (
                <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6, color: '#d4380d' }}>
                  配对码已失效或已过期，请在 Windows 端重新生成后再次连接。
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}




