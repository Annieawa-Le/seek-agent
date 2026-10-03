/**
 * dsh-theme 转义层 —— 把 seek-agent 的渲染层 DOM 伪装成 DSH（DeepSeek Harness）结构。
 *
 * 为什么需要它：DSH 第三方皮肤（skin.json + CSS）里的选择器全部依赖 DSH 的 DOM 契约：
 *   · 类名子串钩子  [class*='_sidebarCol'] / [class*='_frame'] / [class*='_card'] …
 *     —— DSH 是 CSS Modules，编译后类名形如 `wHEsxq_sidebarCol`（hash + '_' + 局部名），
 *        皮肤只依赖下划线后那段局部名。
 *   · 属性钩子      [data-composer-card] / [data-slot='conversation.view'] /
 *                  [data-conversation-scroll] / [data-phase='hero'] …
 *   · 令牌钩子      --dsw-static-* / --dsw-alias-*（见 tokens.js）
 *
 * seek-agent 渲染层用的是稳定 id（#app / #body-row / #left-sidebar …）+ 语义类名，
 * 结构与 DSH 同源（都是三列 + 会话流 + 输入卡），但钩子名字对不上。
 * 本层做三件事：
 *   1) 给既有元素挂「影子类名」——直接写 DSH 局部名，让子串选择器命中；
 *   2) 给既有元素补「属性钩子」与结构替身——data-slot / data-composer-card / data-phase 等，
 *      外加侧栏内容容器（见 installSidebarRoot）与会话树 role 钩子，
 *      把 DSH 的层级关系补齐（DSH 的侧栏是「列 + 列内 SidebarRoot」两层）；
 *   3) 把宿主的盒模型钉住——皮肤照 DSH 的「侧栏是一真列」写死 position/overflow 之类的
 *      布局属性，宿主却是抽屉，加载顺序压不住这些 !important，须由矫正层兜底（LAYOUT_GUARD_CSS）。
 *
 * 两个关键设计约束（来自 docs/dsh-dom-contract.md §8 风险清单）：
 *   · 短名（_row / _root / _column）跨组件误伤严重 —— 本层**不**贴这类短名，
 *     只贴语义明确的长名（_sidebarCol / _composerSeat / _card …），并优先靠属性钩子定位。
 *   · DSH 的 data-slot 包装层硬编码 display:contents，若用普通 div 会打乱 flex/grid 解算。
 *     本层插入的包装一律带 display:contents（见 makeSlot）。
 *
 * 幂等：所有打标都先查 dataset 标记，重复 decorate 不会叠加。
 */

/** 影子类名 → 目标 id/选择器 的映射表（seek-agent 真实结构 → DSH 契约名）。 */
const SHADOW_CLASSES = [
  // ── 三列骨架（DSH：div.frame > div.sidebarCol / div.centerCol / div.detailsCol） ──
  ['#app', ['_frame']],
  ['#body-content', ['_bodyWrap']],
  ['#body-row', []],
  ['#left-sidebar', ['_sidebarCol']],
  ['#main-content', ['_centerCol']],
  ['#info-panel', ['_detailsCol']],
  ['#header', ['_header']],

  // ── 侧边栏内部（ui-sidebar：logoRow / brand / newSession / footArea / settingsArea） ──
  ['#left-sidebar .sidebar-section-header', ['_logoRow']],
  ['#left-sidebar .section-title', ['_brand', '_wide']],
  ['#new-session-btn', ['_newSession']],
  ['#left-sidebar .ns-text', ['_newSessionLabel', '_wide']],
  ['#session-list', ['_regionArea']],
  ['#left-sidebar .session-item', ['_chatItem']],
  ['#sidebar-spacer', ['_footArea']],

  // ── 会话流（ui-conversation：scrollBody / viewArea / column / flowItem） ──
  // 注意：这里一律用「带 hash 的完整形态」（如 fWNiuW_column）而不是裸短名 _column ——
  // 契约 §8.1 指出裸短名会跨组件大面积误命中（DSH 自身都撞名），完整形态才安全。
  ['#message-area', ['_3Oyx4a_scrollBody']],
  ['#message-list', ['fWNiuW_column']],
  ['#message-list .message', ['fWNiuW_flowItem']],
  ['.message.agent', ['fWNiuW_root']],
  ['.message.user', ['_hash_userRow']],

  // ── 输入区（ui-conversation InputBar：card / row / tools / modes / trailing / primary） ──
  ['.input-bar', ['_3Oyx4a_composerSeat']],
  ['.input-bar-body', ['_7tt59G_card']],
  ['.input-toolbar', ['_7tt59G_row']],
  ['.input-toolbar-left', ['_7tt59G_tools']],
  ['.input-actions', ['_7tt59G_trailing']],
  ['.input-field-area', ['_7tt59G_grow']],
  ['.send-btn', ['_7tt59G_primary']],
];

/** 属性钩子映射：选择器 → { 属性名: 值 }。值为 null 表示布尔属性（写空串）。 */
const ATTRIBUTE_HOOKS = [
  // 三列窗格标记（DSH 0.2 契约）：dsh-web-ui / EAC 内置系列皮肤用
  // [data-pane=sidebar|conversation|details] 定位三列，铺列背景与分隔；缺了它那批
  // 规则整体落空，三列会退回宿主底色。
  // sidebar 一列贴在列本身（#left-sidebar），列内的内容容器由 installSidebarRoot() 补：
  // 皮肤写 `[data-pane=sidebar] > div` 指的是列内的那层容器，而不是列自己的子元素
  ['#left-sidebar', { 'data-pane': 'sidebar' }],
  ['#main-content', { 'data-pane': 'conversation' }],
  ['#info-panel', { 'data-pane': 'details' }],
  // 会话列顶栏：DSH 契约写作 `[data-pane=conversation] > div > header`（slot 包装 > 会话根 > 顶栏），
  // seek-agent 的顶栏却是 #app 下的全局 #header，位置对不上。先在此打钩子，
  // 由加载器的 adaptDshSelectors 把那串前缀整体改写过来。
  ['#header', { 'data-dsh-conv-header': null }],
  // 会话滚动口（DSH：div._3Oyx4a_scrollBody[data-conversation-scroll]）
  ['#message-area', { 'data-conversation-scroll': null }],
  // 输入卡：DSH 实际渲染为 data-composer-card=""（皮肤若写 ='true' 在原宿主也匹配不到）
  ['.input-bar-body', { 'data-composer-card': null }],
  // 草稿草稿滚动口
  ['.input-field-area', { 'data-input-scroll': null }],
  // composer 座位（皮肤用 :has([data-slot='settings.header']) 之类做联动）
  ['.input-bar', { 'data-composer-seat': null }],
  // 提交按钮（DSH：button._7tt59G_primary[aria-label='发送']）
  ['.send-btn', { 'data-composer-primary': null }],
];

/** 槽位钩子：DSH 的 data-slot 包装（display:contents 的中性锚点）。 */
const SLOT_HOOKS = [
  ['#app', 'root'],
  ['#left-sidebar', 'sidebar'],
  ['#main-content', 'conversation'],
  ['#info-panel', 'details'],
  ['#message-list', 'conversation.view'],
  ['#main-content', 'conversation.session'],
];

/**
 * 布局矫正层 —— 皮肤 CSS 是照 DSH 的三列骨架写的：侧栏是 frame 里并排的一真列，
 * 内容列（会话流、输入卡）因此天然让开它。seek-agent 的侧栏却是 fixed 抽屉：
 * 不占列宽，.open 才滑入，收起时整块让出画面。
 *
 * 皮肤照搬过来的 `position: relative !important` 会把它拽回文档流——收起时仍占一整列宽，
 * 于是消息区被顶到右边，左边空出一条只看得见底色的空档（场景层按占位宽让位，没人画那一块）。
 * 同理，皮肤为贴满纹样写的 `overflow: hidden` 会把会话列表的纵向滚动一起掐掉。
 *
 * 选择器刻意叠三层 id（`#app #body-row > #left-sidebar`）抬高特异性：皮肤规则普遍带
 * !important，而本层样式注入早于皮肤样式，只靠加载顺序压不住。
 */
const LAYOUT_GUARD_ID = 'dsh-theme-layout-guard';
const LAYOUT_GUARD_CSS = [
  // 皮肤照 DSH「侧栏是真列」写死了定位与层叠，宿主却是 fixed 抽屉，两样都得钉住：
  //   · position —— 皮肤写 position:relative，侧栏会被拽回文档流（收起时不滑走、占着 260px）；
  //   · z-index —— 皮肤给列写的是 `z-index:auto`（DSH 里列在 grid 内不需要层叠），
  //     一旦生效侧栏就沉到 .sidebar-overlay（150）底下，展开后整片被盖住。
  // 三层 id + !important 压过皮肤（皮肤规则最高也就 body[…] + 两个属性选择器）。
  '#app #body-row > #left-sidebar { position: fixed !important; z-index: 200 !important; }',
  '#app #body-row > #left-sidebar { overflow-y: auto !important; overflow-x: hidden !important; }',
  // 宿主把内容内边距挂在列上，DSH 是挂在列内那层（SidebarRoot）上 —— 迁过去。
  // 不迁的话，皮肤给内容容器铺的底色（如 xp 的米色）四周会露出一圈宿主列底色（16px / 12px）。
  '#app #body-row > #left-sidebar { padding: 0 !important; }',
  // 内容容器的列内布局（容器由 installSidebarRoot 补，见那里的说明）：
  // 撑满列（皮肤可能给它铺背景），且不收缩（内容超高时交给列的 overflow 滚动）；
  // padding 用宿主间距变量兜底 —— 皮肤若自己写 `> div { padding: … }`，boost 过后的特异性更高会压过它。
  '#left-sidebar > [data-dsh-sidebar-root] { display: flex; flex-direction: column; flex: 1 0 auto; min-width: 0; padding: var(--space-4, 16px) var(--space-3, 12px); }',
].join('\n');

/** 装布局矫正层（幂等）。 */
function installLayoutGuard() {
  const d = doc();
  if (!d || d.getElementById(LAYOUT_GUARD_ID)) return;
  const el = d.createElement('style');
  el.id = LAYOUT_GUARD_ID;
  el.dataset.dshThemeOwned = '1';
  el.textContent = LAYOUT_GUARD_CSS;
  d.head.appendChild(el);
}

/** 卸布局矫正层。 */
function removeLayoutGuard() {
  doc()?.getElementById(LAYOUT_GUARD_ID)?.remove();
}

/**
 * 侧栏内容容器 —— DSH 的侧栏是两层：列（`[data-pane=sidebar]`）里面还有一层 SidebarRoot，
 * 顶栏、新建会话按钮、会话树都挂在 SidebarRoot 下。皮肤据此写
 *   `… > div { … }`            —— xp 给这层铺米色底；maid-atelier 把它重置成 transparent
 *   `… > div > :not(…) { … }`  —— 给容器的子元素抬层
 *   `… > div > button { … }`   —— 新建会话按钮
 *
 * seek-agent 只有一层：列自己就是内容的容器，于是 `> div` 会落到 .sidebar-section-header
 * 之类的元素上，整片规则错位 —— maid-atelier 的 `> div { background: initial }` 更是直接把
 * 列自己的深海蓝背景清空，xp 的顶栏渐变也会打到标题文字上。这里在列内补一层内容容器，
 * 把固定子节点搬进去（列内布局见 LAYOUT_GUARD_CSS）。
 *
 * 只搬「固定渲染」的子节点（白名单）：条件渲染出来的节点（如远程连接条）留在外层，
 * 免得 React 卸载它时 parentNode 对不上、removeChild 抛错。
 *
 * 幂等：以 SIDEBAR_ROOT_ATTR 认领，重复调用直接返回。
 */
const SIDEBAR_ROOT_ATTR = 'data-dsh-sidebar-root';
// 注意用 `:scope >`：裸的 `> .foo` 不是合法选择器（Chromium 会直接抛错）
const SIDEBAR_ROOT_CHILDREN = [
  ':scope > .sidebar-section-header',
  ':scope > #new-session-btn',
  ':scope > #session-list',
  ':scope > #sidebar-spacer',
];

function installSidebarRoot() {
  const d = doc();
  const sidebar = d?.querySelector('#left-sidebar');
  if (!sidebar) return;
  for (const c of sidebar.children) {
    if (c.hasAttribute?.(SIDEBAR_ROOT_ATTR)) return; // 已就位
  }
  const root = d.createElement('div');
  root.setAttribute(SIDEBAR_ROOT_ATTR, '');
  for (const sel of SIDEBAR_ROOT_CHILDREN) {
    const el = sidebar.querySelector(sel);
    if (el) root.appendChild(el);
  }
  sidebar.appendChild(root);
}

/** 拆掉内容容器，把子节点还回列（卸载皮肤时用）。 */
function removeSidebarRoot() {
  const d = doc();
  const sidebar = d?.querySelector('#left-sidebar');
  if (!sidebar) return;
  let root = null;
  for (const c of sidebar.children) {
    if (c.hasAttribute?.(SIDEBAR_ROOT_ATTR)) { root = c; break; }
  }
  if (!root) return;
  while (root.firstChild) sidebar.insertBefore(root.firstChild, root);
  root.remove();
}

/**
 * 会话树钩子 —— DSH 的侧栏会话项是 role=treeitem 的树节点（当前项另带 aria-selected），
 * 皮肤用 `[data-pane=sidebar] [role=treeitem]` 定位整片列表。seek-agent 的 .session-item
 * 只是普通 div，那条规则整片落空，列表外观退回宿主。
 */
function markSessionTree() {
  const d = doc();
  if (!d) return;
  for (const el of d.querySelectorAll('#left-sidebar .session-item')) {
    setHook(el, 'role', 'treeitem');
    if (el.classList.contains('active')) setHook(el, 'aria-selected', 'true');
    else el.removeAttribute('aria-selected');
  }
}


function doc() {
  return typeof document !== 'undefined' ? document : null;
}

/** 幂等打标：给元素追加影子类名（去重，不覆盖已有 class）。 */
function addClasses(el, classes) {
  for (const cls of classes) {
    if (!el.classList.contains(cls)) el.classList.add(cls);
  }
}

/** 幂等写属性：值为 null 时写空串（与 DSH 的布尔属性写法一致）。 */
function setHook(el, name, value) {
  const want = value === null ? '' : String(value);
  if (el.getAttribute(name) !== want) el.setAttribute(name, want);
}

/**
 * 会话相位（DSH：data-phase = hero | active | settling）。
 * 贴着 DSH 的语义：hero = 没有真实对话（启动页），active = 正常对话。
 * seek-agent 的判据用「消息列表里有没有真实消息」——与 hasRealMessage 同源。
 */
function computePhase() {
  const list = doc()?.querySelector('#message-list');
  if (!list) return 'hero';
  for (const child of list.children) {
    if (child.classList.contains('message')) return 'active';
  }
  // 消息列表为空时主区显示的是模式选择启动页
  return 'hero';
}

/** 把相位写到 #app 与输入卡祖先上（皮肤多用 [data-phase='active'] [data-composer-card]）。 */
function applyPhase() {
  const phase = computePhase();
  const app = doc()?.querySelector('#app');
  if (app) setHook(app, 'data-phase', phase);
  const body = doc()?.querySelector('#body-row');
  if (body) setHook(body, 'data-phase', phase);
  return phase;
}

/**
 * 侧边栏折叠态（DSH：data-sidebar-collapsed 在 frame 上）。
 *
 * 判据只有 .open 类：seek-agent 的侧栏在任何窗口宽度下都是抽屉（收起时整块让出画面），
 * 没有 DSH 那种「宽屏侧栏常驻」的形态——早先按窗口像素宽近似展开态，宽屏上抽屉明明收着，
 * 皮肤却收到「已展开」的信号。
 */
function applyCollapseState() {
  const app = doc()?.querySelector('#app');
  const sidebar = doc()?.querySelector('#left-sidebar');
  if (!app || !sidebar) return;
  const open = sidebar.classList.contains('open');
  if (open) app.removeAttribute('data-sidebar-collapsed');
  else setHook(app, 'data-sidebar-collapsed', null);

  const panel = doc()?.querySelector('#info-panel');
  if (panel) {
    const closed = panel.classList.contains('info-panel-closed');
    if (closed) setHook(app, 'data-details-collapsed', null);
    else app.removeAttribute('data-details-collapsed');
  }
}

/**
 * 把侧栏「占位宽度」写进 --dsh-sidebar-width（皮肤用它做场景层内嵌与内容列偏移）。
 *
 * 写的是占位宽而非盒子宽：侧栏是抽屉，收起时不占任何列宽，变量必须归零。
 * 若照搬盒子宽（恒为 260），收起态皮肤仍按「让开一列」推导——场景层从 260px 起铺，
 * 左边缘空出一条没人画的底色，内容列也跟着让位，看起来正是「黑底把消息区顶到右边」。
 */
function syncSidebarWidth() {
  const sidebar = doc()?.querySelector('#left-sidebar');
  const root = doc()?.documentElement;
  if (!sidebar || !root) return;
  const occupied = sidebar.classList.contains('open')
    ? Math.round(sidebar.getBoundingClientRect().width)
    : 0;
  root.style.setProperty('--dsh-sidebar-width', `${occupied}px`);
}

/** 单次全量打标。幂等，可反复调用。 */
export function decorate() {
  const d = doc();
  if (!d) return { phase: 'hero', marked: 0 };
  installLayoutGuard();
  installSidebarRoot();
  let marked = 0;

  for (const [selector, classes] of SHADOW_CLASSES) {
    for (const el of d.querySelectorAll(selector)) {
      addClasses(el, classes);
      el.dataset.dshThemeMark = '1';
      marked++;
    }
  }
  for (const [selector, hooks] of ATTRIBUTE_HOOKS) {
    for (const el of d.querySelectorAll(selector)) {
      for (const [name, value] of Object.entries(hooks)) setHook(el, name, value);
      el.dataset.dshThemeMark = '1';
      marked++;
    }
  }
  for (const [selector, slot] of SLOT_HOOKS) {
    for (const el of d.querySelectorAll(selector)) {
      setHook(el, 'data-slot', slot);
      marked++;
    }
  }

  const phase = applyPhase();
  markSessionTree();
  applyCollapseState();
  syncSidebarWidth();
  return { phase, marked };
}

/** 清除全部打标（卸载皮肤时用，避免残留类名污染）。 */
export function undecorate() {
  const d = doc();
  if (!d) return;
  removeLayoutGuard();
  // 会话树钩子与 slot 包装都是本层加的结构，不属于宿主——卸皮肤时一并还原，
  // 别把 role=treeitem / 包装层留给宿主
  for (const el of d.querySelectorAll('#left-sidebar .session-item')) {
    el.removeAttribute('role');
    el.removeAttribute('aria-selected');
  }
  removeSidebarRoot();
  for (const el of d.querySelectorAll('[data-dsh-theme-mark]')) {
    delete el.dataset.dshThemeMark;
  }
  const root = d.documentElement;
  root.style.removeProperty('--dsh-sidebar-width');
  const app = d.querySelector('#app');
  if (app) {
    app.removeAttribute('data-phase');
    app.removeAttribute('data-sidebar-collapsed');
    app.removeAttribute('data-details-collapsed');
  }
  const body = d.querySelector('#body-row');
  if (body) body.removeAttribute('data-phase');
}

/**
 * 挂上持续观测：DOM 变化（React 重渲染）与窗口尺寸变化时重新打标。
 * 返回一个 stop() 用于卸载。
 */
export function startObserving() {
  const d = doc();
  if (!d || !d.body) return { stop() {} };
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      try { decorate(); } catch { /* 打标失败不影响主功能 */ }
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(d.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);

  // 抽屉开合只是 #left-sidebar 的 class 切换，childList 模式收不到；单独盯它，
  // 折叠态镜像（data-sidebar-collapsed 与 --dsh-sidebar-width）才能即时跟上。
  let observedSidebar = null;
  let sidebarObserver = null;
  const observeSidebar = () => {
    const sidebar = d.querySelector('#left-sidebar');
    if (!sidebar || sidebar === observedSidebar) return;
    sidebarObserver?.disconnect();
    observedSidebar = sidebar;
    sidebarObserver = new MutationObserver(schedule);
    sidebarObserver.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  };

  decorate();
  observeSidebar();
  return {
    stop() {
      observer.disconnect();
      sidebarObserver?.disconnect();
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}




