/**
 * dsh-theme 皮肤加载器 —— 把 DSH 皮肤包装进 seek-agent 运行。
 *
 * 皮肤包格式（照 DSH 第三方皮肤约定）：
 *   skin.json   元信息（id / name / palette / assets / css / scope / colorScheme）
 *   skin.css    皮肤样式（选择器全部是 DSH 的 DOM 契约）
 *   assets/*    贴图资源
 *
 * skin.json 的 colorScheme（'dark' / 'light' / 缺省）声明皮肤是不是只有一套固定配色。
 * 声明了就在加载期间锁定宿主亮暗（见 pinColorScheme）——宿主有 70 余条亮色覆写，
 * 单色皮肤压不住它们，会满屏亮色补丁。
 *
 * 加载流程：
 *   1. 从宿主取皮肤清单（GET /skins）与资源（/skins/<id>/...）
 *   2. 装令牌层（tokens.js）→ 装转义层（escape-layer.js）→ 等 DOM 就绪
 *   3. 注入 skin.css，并把它内部的资源相对路径改写成宿主绝对地址
 *   4. 给 body 打上皮肤作用域属性（DSH 皮肤用 body[data-xxx-skin] 圈定作用域）
 *   5. 执行皮肤的装饰脚本（若 skin.json 声明 script）——脚本拿到的是「伪 ctx」
 *
 * 伪 ctx：DSH 皮肤脚本签名是 apply(ctx)，用 ctx.effect(fn, name) 注册可清理副作用。
 * 本层提供一个最小 ctx 实现，让皮肤脚本无须改动即可运行。
 */

import { decorate, startObserving, undecorate } from './escape-layer.js';
import { installTokens, syncThemeAttribute, watchTheme, uninstallTokens } from './tokens.js';

const OWNED = 'dsh-theme';
/** 固定配色皮肤的主题锁定状态（同一时刻只可能有一套皮肤生效）。 */
let pin = null;
/** 换皮肤时被跳过的「还主题」值（用户偏好），等新皮肤表态后要么被它接手、要么写回宿主。 */
let carryOver = null;

/**
 * 按皮肤声明的配色锁定宿主亮暗主题。
 *
 * 单色皮肤（原版 roxy 就是纯暗色）遇上宿主的另一套亮暗时，宿主那侧会成为「敌意样式」：
 * 渲染层 style.css 里有 70 余条 [data-theme='light'] 覆写（白底输入栏、浅色代码块、亮色气泡…），
 * 皮肤那几十条声明压不住全部，于是皮肤上到处是亮色补丁——看着就是「皮肤主题色没应用上」。
 * 逐条对抗不现实，正解是皮肤说了算：加载期间把 html[data-theme] 钉成皮肤声明的配色，
 * 用户此刻的偏好记下来，卸载皮肤时原样还回去。
 */
function pinColorScheme(scheme) {
  // 换皮肤的中途卸载会跳过还原，偏好先寄存在 carryOver 里，由新皮肤决定爱不爱用
  carryOver = detachPin() || carryOver;
  if (scheme !== 'dark' && scheme !== 'light') {
    // 新皮肤不锁定配色（多配色皮肤自己按 data-ds-dark-theme 分支）→ 把偏好还回宿主
    restoreUserTheme();
    return null;
  }
  const html = document.documentElement;
  const state = {
    scheme,
    // 用户自己的偏好——卸载皮肤时要还给它
    userTheme: carryOver || (html.dataset.theme === 'light' ? 'light' : 'dark'),
  };
  state.observer = new MutationObserver(() => {
    const now = html.dataset.theme === 'light' ? 'light' : 'dark';
    if (now === state.scheme) return;
    // App 按用户偏好写了新值：记下偏好，再钉回去
    // （写回会再触发一次本回调，值已相同即收敛，不会打转）
    state.userTheme = now;
    html.dataset.theme = state.scheme;
  });
  state.observer.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
  carryOver = null;
  pin = state;
  html.dataset.theme = state.scheme;
  return state;
}

/** 拆掉锁定监听（不动宿主属性），返回皮肤记下的「用户偏好」。 */
function detachPin() {
  if (!pin) return null;
  const userTheme = pin.userTheme;
  pin.observer.disconnect();
  pin = null;
  return userTheme;
}

/** 把宿主主题还原成用户自己的偏好（卸载皮肤、或新皮肤不吃配色时用）。 */
function restoreUserTheme(fallback = null) {
  const target = carryOver || fallback;
  carryOver = null;
  if (target) document.documentElement.dataset.theme = target;
  return target;
}


/** 已经加载的皮肤状态（单例：同时只允许一套皮肤生效）。 */
let active = null;

/**
 * 宿主地址。
 *
 * 认插件专属的 __SEEK_THEME_HOST，而不是与其它挂件共用的 __SEEK_EXT_HOST：
 * 后者是「最后注入者胜」的共享槽——视觉卡片宿主（dsh-raw-html）也往里写自己的端口，
 * 它只要晚于本插件注入，这里读到的就是卡片端口，/skins 必然 404。
 * 兼容回退保留，供手工注入加载器的老场景使用。
 */
function hostBase() {
  const w = typeof window !== 'undefined' ? window : null;
  const base = String((w && (w.__SEEK_THEME_HOST || w.__SEEK_EXT_HOST)) || '').replace(/\/+$/, '');
  if (!base) console.warn('[dsh-theme] 宿主地址为空——__SEEK_THEME_HOST 未注入或已被清掉');
  return base;
}

/** 取回宿主上的皮肤清单。 */
async function fetchSkins() {
  const base = hostBase();
  if (!base) return [];
  try {
    const res = await fetch(`${base}/skins`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.skins) ? data.skins : [];
  } catch {
    return [];
  }
}

/** 取回某个皮肤包的元信息 + CSS 文本。 */
async function fetchSkinBundle(id) {
  const base = hostBase();
  const meta = await fetch(`${base}/skins/${encodeURIComponent(id)}/skin.json`, { cache: 'no-store' });
  if (!meta.ok) {
    console.warn('[dsh-theme] skin.json 请求失败', { url: meta.url, status: meta.status, base });
    throw new Error(`skin.json 读取失败：${meta.status}（${meta.url}）`);
  }
  const skin = await meta.json();
  let css = '';
  if (skin.css) {
    const res = await fetch(`${base}/skins/${encodeURIComponent(id)}/${skin.css}`, { cache: 'no-store' });
    if (res.ok) css = await res.text();
  }
  return { skin, css };
}

/**
 * DSH 契约适配（CSS 文本层）—— 补转义层补不了的那一处：根节点 id。
 *
 * DSH 0.2（dsh-web-ui / EAC 内置系列皮肤）把应用根写成 `[id=root]`，seek-agent 的根是
 * `#app`。转义层能往元素上补类名与 data-* 钩子，却补不了 id（id 是宿主结构的一部分），
 * 于是在样式注入前做一次等价替换 —— 属性选择器与 id 选择器特异性同为 (1,0,0)，
 * 皮肤作者写下的优先级关系原样保留。
 */
const DSH_ROOT_ID_RE = /\[id=['\"]?root['\"]?\]/g
/** 同一契约的 id 选择器写法（`#root > div > div`）。用负向断言避开 `#root-xxx` 这类同前缀类名。 */
const DSH_ROOT_HASH_RE = /#root(?![-\w])/g

/**
 * 会话列顶栏 —— DSH 契约写作 `[data-pane=conversation] > div > header`
 * （slot 包装 > 会话根 > 顶栏）。seek-agent 的顶栏是 #app 下的全局 #header，不在会话列里，
 * 靠 DOM 包装补不上（把顶栏塞进会话列会打乱「整行顶栏 + 三列」的两行布局）。
 * 转义层已在 #header 上打了 data-dsh-conv-header 钩子，这里把那串前缀整体改写过去，
 * 保留尾巴（` button` / `:hover`）与可能夹在中间的暗色修饰。
 */
const DSH_CONV_HEADER_RE =
  /\[data-pane=['\"]?conversation['\"]?\](?:(\[data-ds-dark-theme\]))?\s*>\s*div\s*>\s*header\b/g

function adaptDshSelectors(css) {
  return css
    .replace(DSH_ROOT_ID_RE, '#app')
    .replace(DSH_ROOT_HASH_RE, '#app')
    .replace(DSH_CONV_HEADER_RE, (_whole, dark) =>
      dark ? `${dark} [data-dsh-conv-header]` : '[data-dsh-conv-header]')
}

/**
 * 侧栏占位偏移归零 —— DSH 的侧栏是「真实的一列」，内容列被它挤开，皮肤据此把顶部/底部饰边、
 * 左右角色立绘整体平移一个侧栏宽度（maid-atelier 的 `translate: var(--maid-sidebar-width) 0`，
 * roxy 的场景层 `inset: 0 0 0 var(--dsh-sidebar-width)`）。seek-agent 的侧栏是浮层抽屉、
 * 不占位，内容区铺满全宽 —— 这些偏移会让饰边左侧空出一块。
 *
 * 变量名是皮肤私有的，CSS 里没法通配，所以从皮肤 CSS 原文里扫出所有「侧栏宽度」类变量名，
 * 在 body 及其后代上统一钉成 0（`!important` 压过皮肤脚本用 CSSOM 写入的值）。
 * `--dsh-*` 由我们自己维护（转义层按 seek-agent 的语义写），不在此列。
 */
const SIDEBAR_WIDTH_VAR_RE = /--[a-z0-9-]*sidebar-width[a-z0-9-]*/gi

function neutralizeSidebarOffset(css, scopeAttr) {
  if (!scopeAttr) return ''
  const vars = new Set()
  for (const m of css.matchAll(SIDEBAR_WIDTH_VAR_RE)) {
    if (m[0].toLowerCase().startsWith('--dsh-')) continue
    vars.add(m[0])
  }
  if (vars.size === 0) return ''
  const decl = [...vars].map((v) => `${v}:0px !important;`).join('')
  return `\nbody[${scopeAttr}],body[${scopeAttr}] *{${decl}}`
}

/**
 * 把皮肤 CSS 里的相对资源路径改写成宿主绝对地址。
 * 皮肤原文写的是 `url("./assets/bg.webp")` 或裸 `assets/xxx`，浏览器会按当前页面
 * （seek-agent 渲染层的 file:// 地址）解析，必然 404 —— 这里统一指到宿主。
 */
function rewriteAssetUrls(css, skinId) {
  const base = hostBase();
  const prefix = `${base}/skins/${encodeURIComponent(skinId)}/`;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, quote, url) => {
    const raw = url.trim();
    // 已是绝对地址（http/https/data/blob）或 CSS 变量，原样保留
    if (/^(https?:|data:|blob:|#|var\()/i.test(raw)) return whole;
    // 站点绝对路径（/xxx）也原样保留
    if (raw.startsWith('/')) return whole;
    const normalized = raw.replace(/^\.\//, '');
    return `url(${quote}${prefix}${normalized}${quote})`;
  });
}

/**
 * 特异性提升 —— DSH 皮肤的选择器普遍长这样：`body[data-dsh-xp] [data-pane=sidebar] > div > button`
 * （属性选择器），而宿主 style.css 对同一批元素写的是 id 选择器（`#left-sidebar` /
 * `#new-session-btn` / `#header` …）。id 的 (1,0,0) 恒压过属性选择器——皮肤就算命中了元素，
 * 计算样式也赢不了，表现就是「侧栏底色、新建按钮、会话列顶栏还是宿主原样」。
 *
 * 解法：给皮肤样式表每条规则统一加 `:not(#dsh-theme-boost)` 前缀（+1,0,0）。
 * 那个 id 永不出现，匹配集合不变，只是整体压过宿主的 id 规则；皮肤规则之间的相对优先级
 * 也原样保留（全部同幅提升）。只动皮肤自己注入的 <style>，不碰宿主样式表。
 */
const BOOST_PREFIX = ':not(#dsh-theme-boost)';

/**
 * 按**顶层**逗号拆选择器列表 —— `:is(a, b)` / `:not(a, b)` / `[attr="x,y"]` 里的逗号不能被拆散，
 * 否则前缀会被塞进函数内部，把 `:is(A, B)` 拆成 `:is(A, :not(#x) B)`，语义与特异性都走样。
 */
function splitSelectorList(sel) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const c = sel[i];
    if (quote) {
      if (c === quote && sel[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(sel.slice(start, i)); start = i + 1; }
  }
  parts.push(sel.slice(start));
  return parts;
}

function boostSpecificity(styleEl) {
  const sheet = styleEl.sheet;
  if (!sheet) return 0;
  let n = 0;
  const walk = (rules) => {
    for (const rule of rules) {
      if (typeof rule.selectorText === 'string' && rule.style) {
        const boosted = splitSelectorList(rule.selectorText).map((sel) => {
          const s = sel.trim();
          // 嵌套规则（& 开头）不动：加前缀后会被解析成非法选择器
          if (!s || s.startsWith('&')) return s;
          return `${BOOST_PREFIX} ${s}`;
        }).join(', ');
        try { rule.selectorText = boosted; n += 1; } catch { /* 个别选择器拒绝改写就跳过 */ }
      }
      if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
    }
  };
  walk(sheet.cssRules);
  return n;
}

/** 注入皮肤样式表（带皮肤作用域与所有权标记）。 */
function installSkinCss(skinId, css) {
  const existing = document.getElementById(`dsh-theme-skin-${skinId}`);
  if (existing) existing.remove();
  const el = document.createElement('style');
  el.id = `dsh-theme-skin-${skinId}`;
  el.dataset.dshThemeOwned = '1';
  el.dataset.dshThemeSkin = skinId;
  el.textContent = css;
  document.head.appendChild(el);
  boostSpecificity(el);
  return el;
}

/**
 * 最小 ctx 实现（DSH 皮肤脚本的运行时契约）。
 * 皮肤用 ctx.effect(fn, name) 注册副作用，fn 返回清理函数。
 */
function createFakeContext() {
  const disposers = [];
  return {
    effect(fn, name) {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push({ name, dispose });
      } catch (err) {
        console.warn(`[dsh-theme] 皮肤 effect「${name || 'anonymous'}」执行失败：`, err);
      }
    },
    /**
     * 服务探测降级。DSH 皮肤（交易终端 / 同花顺这类）会用 ctx.get('workspaces')
     * 之类的服务查询喂状态栏数据，seek-agent 没有对应服务：一律返回 undefined，
     * 皮肤一侧普遍写成 `if (x === void 0) return`，自然退化成占位文案，不炸。
     */
    get() {
      return undefined;
    },
    _disposeAll() {
      for (const { dispose } of disposers) {
        try { dispose(); } catch { /* 清理失败不阻断 */ }
      }
      disposers.length = 0;
    },
  };
}

/** 执行皮肤自带的装饰脚本（若声明了 script 且宿主提供了该文件）。 */
async function runSkinScript(skinId, skin) {
  if (!skin.script) return null;
  const base = hostBase();
  const url = `${base}/skins/${encodeURIComponent(skinId)}/${skin.script}`;
  const ctx = createFakeContext();
  try {
    const mod = await import(/* @vite-ignore */ url);
    const apply = mod.apply || mod.default;
    if (typeof apply === 'function') apply(ctx);
  } catch (err) {
    console.warn('[dsh-theme] 皮肤脚本加载失败（皮肤仍以纯 CSS 方式生效）：', err);
  }
  return ctx;
}

/** 等 DOM 主体可打标。 */
function whenBodyReady() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

/**
 * 加载并启用一套皮肤。
 * @param {string} id 皮肤 id（对应 themes/<id>/）
 * @returns {Promise<{ok: boolean, id?: string, name?: string, error?: string, stats?: object}>}
 */
export async function activateSkin(id) {
  try {
    await whenBodyReady();
    // 换皮肤：中途这次卸载不还原宿主主题，交给新皮肤紧接着锁定
    if (active) await deactivateSkin({ restoreTheme: false });

    const { skin, css } = await fetchSkinBundle(id);
    const scope = skin.scope || {};
    const owner = scope.owner || skin.id || id;

    // 1) 令牌层（皮肤消费 --dsw-* 的前提）
    installTokens();
    const themeWatch = watchTheme();
    syncThemeAttribute();

    // 1.5) 固定配色的皮肤：把宿主亮暗钉到皮肤声明的配色上（宿主那 70 余条亮色覆写就此失效）
    const pinned = pinColorScheme(skin.colorScheme);
    if (pinned) {
      const label = pinned.scheme === 'dark' ? '暗色' : '亮色';
      console.info(
        `[dsh-theme] 皮肤「${skin.name || id}」只提供${label}配色，加载期间已锁定宿主主题`,
        '（卸载皮肤后恢复你自己的亮暗偏好）',
      );
    }

    // 2) 转义层（皮肤选择器命中的前提）
    const observing = startObserving();
    decorate();

    // 3) 皮肤样式（资源路径改写后注入，保证晚于令牌层——特异性覆盖需要它靠后）
    const styleEl = installSkinCss(
      id,
      rewriteAssetUrls(adaptDshSelectors(css), id) + neutralizeSidebarOffset(css, scope.bodyAttribute),
    );

    // 4) 皮肤作用域属性 + 页面标题/主题色
    if (scope.bodyAttribute) {
      document.body.setAttribute(scope.bodyAttribute, owner);
    }
    const prevTitle = document.title;
    if (scope.title) document.title = scope.title;
    let metaTheme = document.querySelector('meta[name="theme-color"]');
    const prevThemeColor = metaTheme ? metaTheme.content : null;
    if (scope.themeColor) {
      if (!metaTheme) {
        metaTheme = document.createElement('meta');
        metaTheme.name = 'theme-color';
        document.head.appendChild(metaTheme);
        metaTheme.dataset.dshThemeOwned = '1';
      }
      metaTheme.content = scope.themeColor;
    }

    // 5) 皮肤装饰脚本（伪 ctx）
    const ctx = await runSkinScript(id, skin);

    active = {
      id,
      skin,
      styleEl,
      observing,
      themeWatch,
      ctx,
      prevTitle,
      prevThemeColor,
      bodyAttribute: scope.bodyAttribute,
      owner,
    };
    const stats = decorate();
    return { ok: true, id, name: skin.name, stats };
  } catch (err) {
    // 中途失败：可能已经锁了宿主主题，收回去，别把用户钉在皮肤配色里
    restoreUserTheme(detachPin());
    return { ok: false, id, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * 卸载当前皮肤（恢复宿主原貌）。
 * @param {{restoreTheme?: boolean}} opts restoreTheme=true（默认）连同皮肤锁定的宿主亮暗一起还原；
 *   换皮肤时由 activateSkin 传 false —— 新皮肤马上就会接管，中途还原只会闪一帧宿主配色。
 */
export async function deactivateSkin({ restoreTheme = true } = {}) {
  if (!active) return { ok: true, wasActive: false };
  const a = active;
  active = null;
  try {
    if (a.ctx && typeof a.ctx._disposeAll === 'function') a.ctx._disposeAll();
    a.observing?.stop();
    a.themeWatch?.stop();
    // 皮肤走了：把它锁住的宿主亮暗还给用户（换皮肤时由新皮肤接手，故跳过）
    if (restoreTheme) restoreUserTheme(detachPin());
    a.styleEl?.remove();
    undecorate();
    uninstallTokens();
    if (a.bodyAttribute) document.body.removeAttribute(a.bodyAttribute);
    document.title = a.prevTitle;
    if (a.prevThemeColor !== null && a.prevThemeColor !== undefined) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = a.prevThemeColor;
    } else {
      document.querySelector('meta[name="theme-color"][data-dsh-theme-owned]')?.remove();
    }
    for (const el of document.querySelectorAll(`[data-dsh-theme-owned="1"][data-dsh-theme-skin]`)) el.remove();
  } catch (err) {
    console.warn('[dsh-theme] 卸载皮肤时出错：', err);
  }
  return { ok: true, wasActive: true, id: a.id };
}

/** 当前生效的皮肤信息。 */
export function currentSkin() {
  return active ? { id: active.id, name: active.skin?.name } : null;
}

/** 列出宿主上的全部皮肤。 */
export async function listSkins() {
  return fetchSkins();
}

/**
 * 启动时自动激活 enable.json 里指定的皮肤（宿主通过 window.__SEEK_THEME_BOOT 传下来）。
 */
export async function boot() {
  const wanted = (typeof window !== 'undefined' && window.__SEEK_THEME_BOOT) || null;
  const skins = await listSkins();
  if (skins.length === 0) return { ok: false, error: '宿主上没有可用皮肤包' };
  const target = wanted && skins.some((s) => s.id === wanted) ? wanted : skins[0].id;
  return activateSkin(target);
}

// 暴露到 window 便于运行时切换（Agent 可通过执行 JS 调用）
if (typeof window !== 'undefined') {
  window.__seekTheme = {
    list: listSkins,
    activate: activateSkin,
    deactivate: deactivateSkin,
    current: currentSkin,
    boot,
  };
}




