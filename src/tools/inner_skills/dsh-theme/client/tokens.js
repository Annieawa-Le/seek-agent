/**
 * dsh-theme 令牌层 —— 在 seek-agent 里补齐 DSH 的 CSS 变量契约。
 *
 * 皮肤 CSS 大量消费 DSH 令牌（--dsw-static-* 原子层 / --dsw-alias-* 语义层 /
 * --dsw-specific-* 组件层），若宿主不提供，var() 静默取空值，配色与层次全部失效。
 *
 * 本文件做两件事：
 *  1) 定义整套令牌（照 DSH 的 design-platform.css 契约与语义）；
 *  2) 把 seek-agent 自身的主题状态镜像成 DSH 的主题属性：
 *       seek-agent: html[data-theme='dark'|'light']
 *       DSH:        body[data-ds-dark-theme]（存在即暗色，值为空串）
 *     并额外提供 --dsw-color-* 兼容别名层（antd 体系命名的皮肤会消费它，
 *     DSH 本身不提供这批变量，属已知缺口 —— 见 docs/dsh-token-contract.md §1.3）。
 *
 * 令牌清单以 docs/dsh-token-contract.md 为权威数据源（该文档给出了每条的定义与语义）。
 */

/** DSH 原子色板（--dsw-static-*），亮暗同值。 */
const STATIC_TOKENS = `
--dsw-static-neutral-00: rgb(255,255,255);
--dsw-static-neutral-50: rgb(250,250,250);
--dsw-static-neutral-100: rgb(245,245,245);
--dsw-static-neutral-150: rgb(237,237,237);
--dsw-static-neutral-200: rgb(229,229,229);
--dsw-static-neutral-250: rgb(220,220,220);
--dsw-static-neutral-300: rgb(212,212,212);
--dsw-static-neutral-400: rgb(162,164,166);
--dsw-static-neutral-500: rgb(127,130,135);
--dsw-static-neutral-550: rgb(101,103,107);
--dsw-static-neutral-600: rgb(84,85,87);
--dsw-static-neutral-700: rgb(60,60,61);
--dsw-static-neutral-800: rgb(41,41,41);
--dsw-static-neutral-850: rgb(33,33,35);
--dsw-static-neutral-900: rgb(15,15,15);
--dsw-static-neutral-1000: rgb(0,0,0);
--dsw-static-neutral-bluish-00: rgb(255,255,255);
--dsw-static-neutral-bluish-50: rgb(249,250,251);
--dsw-static-neutral-bluish-60: rgb(245,246,247);
--dsw-static-neutral-bluish-75: rgb(241,243,245);
--dsw-static-neutral-bluish-100: rgb(235,238,242);
--dsw-static-neutral-bluish-150: rgb(233,236,242);
--dsw-static-neutral-bluish-200: rgb(225,229,238);
--dsw-static-neutral-bluish-300: rgb(207,211,214);
--dsw-static-neutral-bluish-400: rgb(173,178,184);
--dsw-static-neutral-bluish-500: rgb(151,157,166);
--dsw-static-neutral-bluish-600: rgb(129,133,140);
--dsw-static-neutral-bluish-700: rgb(97,102,107);
--dsw-static-neutral-bluish-750: rgb(67,69,74);
--dsw-static-neutral-bluish-800: rgb(53,54,56);
--dsw-static-neutral-bluish-850: rgb(44,44,46);
--dsw-static-neutral-bluish-875: rgb(35,35,36);
--dsw-static-neutral-bluish-900: rgb(27,27,28);
--dsw-static-neutral-bluish-950: rgb(21,21,23);
--dsw-static-neutral-bluish-1000: rgb(15,17,21);
--dsw-static-deepseek-50: rgb(237,243,254);
--dsw-static-deepseek-100: rgb(228,237,253);
--dsw-static-deepseek-200: rgb(211,226,255);
--dsw-static-deepseek-300: rgb(183,200,254);
--dsw-static-deepseek-400: rgb(103,158,254);
--dsw-static-deepseek-450: rgb(86,134,254);
--dsw-static-deepseek-500: rgb(65,118,230);
--dsw-static-deepseek-600: rgb(72,104,178);
--dsw-static-deepseek-800: rgb(52,65,91);
--dsw-static-deepseek-900: rgb(40,49,66);
--dsw-static-blue-50: rgb(239,246,255);
--dsw-static-blue-100: rgb(219,234,254);
--dsw-static-blue-300: rgb(147,197,253);
--dsw-static-blue-400: rgb(96,165,250);
--dsw-static-blue-500: rgb(59,130,246);
--dsw-static-blue-600: rgb(37,99,235);
--dsw-static-blue-900: rgb(14,48,116);
--dsw-static-green-100: rgb(230,250,237);
--dsw-static-green-400: rgb(78,209,126);
--dsw-static-green-500: rgb(34,197,94);
--dsw-static-green-900: rgb(35,60,44);
--dsw-static-amber-100: rgb(254,245,231);
--dsw-static-amber-400: rgb(247,173,49);
--dsw-static-amber-500: rgb(245,158,11);
--dsw-static-amber-900: rgb(39,36,31);
--dsw-static-red-50: rgb(254,242,242);
--dsw-static-red-100: rgb(254,226,226);
--dsw-static-red-400: rgb(242,90,90);
--dsw-static-red-500: rgb(239,68,68);
--dsw-static-red-600: rgb(236,19,19);
--dsw-static-red-900: rgb(87,12,12);
`;

/** DSH 语义层（--dsw-alias-* / --dsw-specific-*），亮色一版。 */
const ALIAS_LIGHT = `
--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-00);
--dsw-alias-bg-mask-1: rgba(0,0,0,0.24);
--dsw-alias-bg-mask-2: rgba(0,0,0,0.12);
--dsw-alias-bg-mask-3: rgba(0,0,0,0.48);
--dsw-alias-bg-overlay: var(--dsw-static-neutral-bluish-150);
--dsw-alias-bg-module-platform: var(--dsw-static-neutral-bluish-60);
--dsw-alias-bg-skeleton: rgba(0,0,0,0.04);
--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
--dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-700);
--dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600);
--dsw-alias-label-caption: var(--dsw-static-neutral-bluish-400);
--dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-200);
--dsw-alias-label-primary-dimmed: var(--dsw-static-neutral-bluish-950);
--dsw-alias-label-primary-inverted: var(--dsw-static-neutral-bluish-00);
--dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-00);
--dsw-alias-border-l1: rgba(0,0,0,0.04);
--dsw-alias-border-l2: rgba(0,0,0,0.1);
--dsw-alias-border-l3: rgba(0,0,0,0.12);
--dsw-alias-border-l4: rgba(0,0,0,0.16);
--dsw-alias-border-inverted: rgba(0,0,0,0);
--dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-1000);
--dsw-alias-brand-text: var(--dsw-static-neutral-bluish-1000);
--dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
--dsw-alias-button-info-fill: var(--dsw-static-deepseek-500);
--dsw-alias-button-elevated-fill: var(--dsw-static-neutral-bluish-60);
--dsw-alias-button-floating-hover: var(--dsw-static-neutral-bluish-150);
--dsw-alias-interactive-bg-hover: rgba(0,0,0,0.04);
--dsw-alias-interactive-bg-active: rgba(0,0,0,0.08);
--dsw-alias-state-business-primary: var(--dsw-static-deepseek-500);
--dsw-specific-menu: var(--dsw-alias-bg-layer-3);
--dsw-specific-sidebar-fill: var(--dsw-alias-bg-layer-1);
--dsw-specific-card-fill: var(--dsw-alias-bg-layer-2);
`;

/** DSH 语义层暗色覆盖（与亮色块令牌集合一致，只换值 —— DSH 自身有测试守卫此约束）。 */
const ALIAS_DARK = `
--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950);
--dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-875);
--dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850);
--dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-800);
--dsw-alias-bg-mask-1: rgba(0,0,0,0.5);
--dsw-alias-bg-mask-2: rgba(0,0,0,0.2);
--dsw-alias-bg-mask-3: rgba(0,0,0,0.48);
--dsw-alias-bg-overlay: var(--dsw-static-neutral-bluish-700);
--dsw-alias-bg-module-platform: var(--dsw-static-neutral-bluish-800);
--dsw-alias-bg-skeleton: rgba(255,255,255,0.08);
--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50);
--dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-300);
--dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-400);
--dsw-alias-label-caption: var(--dsw-static-neutral-bluish-600);
--dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-750);
--dsw-alias-label-primary-dimmed: var(--dsw-static-neutral-bluish-100);
--dsw-alias-label-primary-inverted: var(--dsw-static-neutral-bluish-800);
--dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-1000);
--dsw-alias-border-l1: rgba(255,255,255,0.06);
--dsw-alias-border-l2: rgba(255,255,255,0.12);
--dsw-alias-border-l3: rgba(255,255,255,0.16);
--dsw-alias-border-l4: rgba(255,255,255,0.2);
--dsw-alias-border-inverted: rgba(255,255,255,0.06);
--dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-50);
--dsw-alias-brand-text: var(--dsw-static-neutral-bluish-50);
--dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
--dsw-alias-button-info-fill: var(--dsw-static-deepseek-450);
--dsw-alias-button-elevated-fill: rgba(255,255,255,0.06);
--dsw-alias-button-floating-hover: rgba(255,255,255,0.1);
--dsw-alias-interactive-bg-hover: rgba(255,255,255,0.06);
--dsw-alias-interactive-bg-active: rgba(255,255,255,0.1);
--dsw-alias-state-business-primary: var(--dsw-static-deepseek-400);
--dsw-specific-menu: var(--dsw-alias-bg-layer-3);
--dsw-specific-sidebar-fill: var(--dsw-alias-bg-layer-1);
--dsw-specific-card-fill: var(--dsw-alias-bg-layer-2);
`;

/**
 * 兼容别名层 —— antd 体系命名的皮肤（如 roxy）消费这批变量，DSH 本身不提供。
 * 映射依据 docs/dsh-token-contract.md §6.2。
 * 注意：--dsw-alias-brand-primary 在 DSH 里是单色（非蓝），故 --dsw-color-primary
 * 改指 state-business-primary（真·蓝色强调），避免皮肤期待蓝却拿到黑/白。
 */
const COMPAT_LIGHT = `
--dsw-color-bg: var(--dsw-alias-bg-base);
--dsw-color-bg-base: var(--dsw-alias-bg-base);
--dsw-color-bg-layout: var(--dsw-alias-bg-base);
--dsw-color-bg-container: var(--dsw-alias-bg-layer-2);
--dsw-color-bg-elevated: var(--dsw-alias-bg-layer-3);
--dsw-color-border: var(--dsw-alias-border-l2);
--dsw-color-border-secondary: var(--dsw-alias-border-l1);
--dsw-color-text: var(--dsw-alias-label-primary);
--dsw-color-text-secondary: var(--dsw-alias-label-secondary);
--dsw-color-primary: var(--dsw-alias-state-business-primary);
`;

/** 排版与装饰层（--dsw-font-* / --dsw-shadow-*），亮暗共用。 */
const TYPO_TOKENS = `
--dsw-font-family: 'WebUIMain', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
--dsw-font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', Consolas, monospace;
--dsw-shadow-lv1: 0 1px 2px rgba(0,0,0,0.08);
--dsw-shadow-lv1-blur: 0 2px 8px rgba(0,0,0,0.12);
--dsw-shadow-lv2: 0 4px 12px rgba(0,0,0,0.12);
--dsw-shadow-lv3: 0 8px 24px rgba(0,0,0,0.16);
--dsw-mask-blur: blur(16px);
/* 悬空令牌回退（DSH 自身也未定义、其功能组件却在 var() 引用 —— 见契约 §2.6） */
--dsw-alias-label-quaternary: var(--dsw-alias-label-caption);
--dsw-alias-separator-primary: var(--dsw-alias-border-l2);
--dsw-alias-line-secondary: var(--dsw-alias-border-l1);
--dsw-alias-fill-l2: var(--dsw-alias-bg-layer-2);
--dsw-alias-fill-tsp-secondary: var(--dsw-alias-bg-mask-2);
--dsw-alias-border-secondary: var(--dsw-alias-border-l1);
--dsw-alias-bg-primary: var(--dsw-alias-bg-layer-1);
--dsw-alias-label-inverse: var(--dsw-alias-label-primary-inverted);
--dsw-alias-interactive-bg-primary: var(--dsw-alias-interactive-bg-hover);
`;

const STYLE_ID = 'dsh-theme-token-contract';
const DARK_ATTRIBUTE = 'data-ds-dark-theme';

function buildCss() {
  return `/*
 * DSH 令牌契约层 —— 由 dsh-theme 插件注入。
 * 数据源：docs/dsh-token-contract.md（DSH 仓库 packages/client/ui-theme/src/styles/design-platform.css）
 * 卸载：移除本 <style> 即可，宿主原生样式不受影响。
 */
:root, body {
${TYPO_TOKENS}
}
body {
${STATIC_TOKENS}
${COMPAT_LIGHT}
${ALIAS_LIGHT}
}
body[${DARK_ATTRIBUTE}] {
${ALIAS_DARK}
}
/* html 层也放一份，便于皮肤在 html 上读令牌（DSH 只在 body 定义，属已知差异） */
html {
${COMPAT_LIGHT}
}
html[data-theme='dark'] {
${ALIAS_DARK}
}
`;
}

/** 注入令牌样式表（幂等）。 */
export function installTokens() {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    el.dataset.dshThemeOwned = '1';
    document.head.appendChild(el);
  }
  el.textContent = buildCss();
  return el;
}

/**
 * 把 seek-agent 的主题状态镜像成 DSH 的主题属性。
 * seek-agent 写 html[data-theme]，DSH 读 body[data-ds-dark-theme] —— 两边都保持同步。
 */
export function syncThemeAttribute() {
  if (typeof document === 'undefined') return 'light';
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const body = document.body;
  if (!body) return theme;
  if (theme === 'dark') {
    // DSH 契约：属性值为空串（存在性选择器），不是 "true"
    if (body.getAttribute(DARK_ATTRIBUTE) !== '') body.setAttribute(DARK_ATTRIBUTE, '');
  } else if (body.hasAttribute(DARK_ATTRIBUTE)) {
    body.removeAttribute(DARK_ATTRIBUTE);
  }
  document.documentElement.style.colorScheme = theme;
  return theme;
}

/** 观察 html[data-theme] 变化并同步（主题切换时皮肤跟着换）。返回 stop()。 */
export function watchTheme() {
  if (typeof document === 'undefined') return { stop() {} };
  syncThemeAttribute();
  const observer = new MutationObserver(() => {
    try { syncThemeAttribute(); } catch { /* 忽略 */ }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return {
    stop() {
      observer.disconnect();
      const body = document.body;
      if (body) body.removeAttribute(DARK_ATTRIBUTE);
    },
  };
}

/** 移除令牌层（卸载时用）。 */
export function uninstallTokens() {
  document.getElementById(STYLE_ID)?.remove();
}
