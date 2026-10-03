/**
 * dsh-theme 设置栏目 —— 向 seek-agent 设置面板注入「主题」分组。
 *
 * 渲染层提名了一个中立的设置栏目扩展点（window.__SEEK_SETTINGS_EXTENSION）：
 * 插件注册 { id, label, render }，设置面板左列就长出该分组，选中即渲染插件内容。
 * 本脚本不依赖渲染层的任何私有结构，只用扩展点 + React 本体 + 触摸 window.electronAPI。
 *
 * 面板能力：列出已安装皮肤（含调色板预览）→ 点击切换（热切换，无需重启）→ 可卸载回默认。
 */

const SKIN_ID = 'theme';

/** 皮肤卡片：调色板色块 + 名称 + 描述 + 激活态。 */
function SkinCard(React, skin, active, busy, onPick) {
  const e = React.createElement;
  const palette = skin.palette || {};
  const swatches = ['background', 'panel', 'text', 'ice', 'gold']
    .map((k) => palette[k])
    .filter(Boolean);

  return e(
    'div',
    {
      key: skin.id,
      onClick: busy ? undefined : () => onPick(skin.id),
      style: {
        border: active ? '2px solid #3370ff' : '1px solid #e5e7eb',
        borderRadius: 10,
        padding: '12px 14px',
        marginBottom: 12,
        cursor: busy ? 'default' : 'pointer',
        background: active ? '#f4f8ff' : '#fff',
        opacity: busy ? 0.6 : 1,
        transition: 'border-color .15s, background .15s',
      },
    },
    e(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
      e(
        'div',
        { style: { minWidth: 0 } },
        e(
          'div',
          { style: { fontSize: 14, fontWeight: 600, color: '#1f2328', display: 'flex', alignItems: 'center', gap: 8 } },
          skin.name || skin.id,
          e('span', { style: { fontSize: 11, fontWeight: 400, color: '#8c8c8c' } }, skin.id),
        ),
        skin.description
          ? e('div', { style: { fontSize: 12, color: '#8c8c8c', marginTop: 6, lineHeight: 1.6 } }, skin.description)
          : null,
        swatches.length
          ? e(
              'div',
              { style: { display: 'flex', gap: 6, marginTop: 10 } },
              ...swatches.map((c, i) =>
                e('span', {
                  key: i,
                  title: c,
                  style: {
                    width: 22, height: 22, borderRadius: 5,
                    background: c, border: '1px solid rgba(0,0,0,.12)',
                  },
                }),
              ),
            )
          : null,
      ),
      e(
        'span',
        {
          style: {
            flexShrink: 0, fontSize: 12, padding: '3px 10px', borderRadius: 12,
            color: active ? '#fff' : '#8c8c8c',
            background: active ? '#3370ff' : '#f0f0f0',
          },
        },
        active ? '使用中' : '点击启用',
      ),
    ),
  );
}

/**
 * 注册设置栏目。宿主（main.js）在注入后调用一次。
 *
 * 注意：本文件由 executeJavaScript 直接执行（非 ESM 模块加载），故不能有 export 语句——
 * 函数以「全局声明」形式提供，末尾自注册（见文件尾部）。
 */
function registerSettingsPanel() {
  const ext = window.__SEEK_SETTINGS_EXTENSION;
  const React = ext && ext.react;
  if (!ext || typeof ext.register !== 'function') {
    console.warn('[dsh-theme] 渲染层未提供设置扩展点，跳过「主题」栏目注册');
    return () => {};
  }
  if (!React) {
    console.warn('[dsh-theme] 设置扩展点未提供 React 本体，跳过注册');
    return () => {};
  }

  const e = React.createElement;
  const { useState, useEffect, useCallback } = React;

  function ThemeSection() {
    const [skins, setSkins] = useState([]);
    const [active, setActive] = useState('');
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const [error, setError] = useState('');
    const [loaded, setLoaded] = useState(false);

    const load = useCallback(() => {
      const api = window.electronAPI;
      if (!api || typeof api.themeList !== 'function') {
        setError('主进程未提供主题接口');
        setLoaded(true);
        return;
      }
      api.themeList()
        .then((res) => {
          if (res && res.ok) {
            setSkins(res.skins || []);
            setActive(res.active || '');
            if (res.enabled === false) setError('dsh-theme 插件未启用');
          } else {
            setError((res && res.error) || '读取皮肤列表失败');
          }
        })
        .catch((err) => setError(err && err.message ? err.message : '读取失败'))
        .finally(() => setLoaded(true));
    }, []);

    useEffect(() => { load(); }, [load]);

    const pick = useCallback(async (id) => {
      const api = window.electronAPI;
      if (!api || typeof api.themeActivate !== 'function') return;
      setBusy(id);
      setNotice('');
      setError('');
      try {
        const res = await api.themeActivate(id);
        if (res && res.ok) {
          setActive(res.active || '');
          setNotice(res.active ? `已切换到「${res.name || res.active}」，立即生效` : '已恢复默认外观');
        } else {
          setError((res && res.error) || '切换失败');
        }
      } catch (err) {
        setError(err && err.message ? err.message : '切换失败');
      } finally {
        setBusy('');
      }
    }, []);

    const children = [];

    // 提示条
    if (notice) {
      children.push(e('div', {
        key: 'notice',
        style: { fontSize: 12, color: '#2e7d32', background: '#e8f5e9', borderRadius: 6, padding: '8px 12px', marginBottom: 12 },
      }, notice));
    }
    if (error) {
      children.push(e('div', {
        key: 'error',
        style: { fontSize: 12, color: '#c0392b', background: '#fdecea', borderRadius: 6, padding: '8px 12px', marginBottom: 12 },
      }, error));
    }

    children.push(e('div', {
      key: 'desc',
      style: { fontSize: 12, color: '#8c8c8c', marginBottom: 14, lineHeight: 1.7 },
    }, '为 DeepSeek Harness 编写的皮肤包可直接加载：转义层把本应用的结构翻译成 DSH 契约，皮肤样式无需改动。切换立即生效，选择会记住。'));

    if (!loaded) {
      children.push(e('div', { key: 'loading', style: { fontSize: 13, color: '#8c8c8c' } }, '正在读取皮肤…'));
    } else if (skins.length === 0) {
      children.push(e('div', {
        key: 'empty',
        style: { fontSize: 13, color: '#8c8c8c', lineHeight: 1.7 },
      }, '还没有安装皮肤包。把皮肤目录放进 src/tools/inner_skills/dsh-theme/themes/ 后重开设置面板即可看到。'));
    } else {
      for (const s of skins) {
        children.push(SkinCard(React, s, s.id === active, busy === s.id, pick));
      }
      // 单色皮肤会锁住宿主亮暗：说清楚，免得以为亮暗开关坏了
      const activeSkin = skins.find((s) => s.id === active);
      if (activeSkin && (activeSkin.colorScheme === 'dark' || activeSkin.colorScheme === 'light')) {
        const schemeLabel = activeSkin.colorScheme === 'dark' ? '暗色' : '亮色';
        children.push(e('div', {
          key: 'scheme',
          style: {
            fontSize: 12, color: '#5b6b7f', background: '#f5f7fa',
            borderRadius: 6, padding: '8px 12px', marginBottom: 12, lineHeight: 1.7,
          },
        }, `「${activeSkin.name || activeSkin.id}」只提供${schemeLabel}配色：使用期间应用会锁定${schemeLabel}主题`
          + '（宿主另有一套亮暗覆写，单色皮肤压不住它们，混着来会满屏亮色补丁）。'
          + '恢复默认外观后，你自己的亮暗偏好会回来。'));
      }

      // 恢复默认
      if (active) {
        children.push(e(
          'button',
          {
            key: 'reset',
            onClick: busy ? undefined : () => pick(''),
            style: {
              border: '1px solid #d0d3d6', background: '#fff', color: '#444',
              borderRadius: 6, padding: '8px 14px', cursor: busy ? 'default' : 'pointer', fontSize: 12,
            },
          },
          '恢复默认外观',
        ));
      }
    }

    return e('div', null, ...children);
  }

  return ext.register({
    id: SKIN_ID,
    label: '主题',
    order: 90,
    render: () => e(ThemeSection),
  });
}


/**
 * 自注册（自带等待）。
 *
 * 注入时机可能早于渲染层的扩展点模块执行：那时 window.__SEEK_SETTINGS_EXTENSION
 * 还不存在、或 react 仍为 null。因此这里不能「一次性注册、失败即放弃」，
 * 而要等扩展点就绪——监听就绪事件 + 轮询兜底（事件与标志位互补，任何执行顺序都覆盖）。
 *
 * 幂等：已注册过就跳过，避免宿主重试注入造成重复注册。
 */
function autoRegister() {
  if (window.__seekThemePanelUnregister) return; // 已注册

  const ready = () => {
    const ext = window.__SEEK_SETTINGS_EXTENSION;
    return ext && typeof ext.register === 'function' && ext.react;
  };

  if (ready()) {
    window.__seekThemePanelUnregister = registerSettingsPanel();
    return;
  }

  // 等就绪：事件监听（宿主已挂监听时零延迟）+ 轮询兜底（上限 10s）
  let done = false;
  const attempt = () => {
    if (done) return;
    if (ready()) {
      done = true;
      try {
        window.__seekThemePanelUnregister = registerSettingsPanel();
      } catch (err) {
        console.warn('[dsh-theme] 设置栏目注册失败：', err);
      }
      window.removeEventListener('seek:settings-extension-ready', attempt);
    }
  };
  window.addEventListener('seek:settings-extension-ready', attempt);
  // React 回填晚于扩展点模块，事件可能早于回填触发，故加轮询兜底
  let waited = 0;
  const timer = setInterval(() => {
    waited += 200;
    if (done || waited >= 10000) {
      clearInterval(timer);
      if (!done) console.warn('[dsh-theme] 设置扩展点等待超时，未注册「主题」栏目');
      return;
    }
    attempt();
  }, 200);
}

try {
  autoRegister();
} catch (err) {
  console.warn('[dsh-theme] 设置栏目自注册失败：', err);
}
