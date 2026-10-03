/**
 * 洛琪希·星穹水神书库 —— 皮肤装饰脚本（原版 src/client/index.ts 的移植）。
 *
 * 原版是 DSH 的 ESM 客户端插件，签名 apply(ctx)：
 *   · 用 ctx.effect(fn, name) 注册可清理副作用
 *   · 从 import 拿资源（构建期内联为 URL）
 *   · prepend 装饰层、ResizeObserver 量侧栏宽、MutationObserver 盯 DOM 变化
 *
 * 移植差别：
 *   · 资源 URL 改为从皮肤包相对路径解析（宿主托管 /skins/<id>/assets/...）
 *   · 选择器换成 dsh-theme 转义层提供的锚点（#left-sidebar / #message-area …）
 *   · 其余机制逐行保留
 */

const OWNER = 'roxy-migurdia';

/**
 * 皮肤包资源根（宿主注入的地址 + 皮肤 id）。
 * 认主题宿主专属的 __SEEK_THEME_HOST——共享的 __SEEK_EXT_HOST 会被视觉卡片宿主顶掉。
 */
function assetBase() {
  const host = window.__SEEK_THEME_HOST || window.__SEEK_EXT_HOST || '';
  return `${host}/skins/roxy-celestial-library/assets/`;
}

function asset(name) {
  return assetBase() + name;
}

function decorativeImage(kind, src, className) {
  const image = document.createElement('img');
  image.src = src;
  image.alt = '';
  image.className = className;
  image.dataset.roxyOwner = OWNER;
  image.dataset.roxyDecoration = kind;
  image.setAttribute('aria-hidden', 'true');
  image.draggable = false;
  return image;
}

/** 背景 + 立绘的固定场景层。 */
function createScene() {
  const scene = document.createElement('div');
  scene.className = 'roxy-scene';
  scene.dataset.roxyOwner = OWNER;
  scene.setAttribute('aria-hidden', 'true');
  scene.append(
    decorativeImage('background', asset('bg.webp'), 'roxy-scene__background'),
    decorativeImage('character', asset('character.webp'), 'roxy-scene__character'),
  );
  return scene;
}

export function apply(ctx) {
  ctx.effect(() => {
    let observer;
    let sidebarObserver;
    let observedSidebar;
    let frameRequest = 0;
    let decorate = () => {};
    let active = false;
    let previousFrame = '';

    const start = () => {
      if (active || !document.body) return;
      active = true;

      // 场景层 + 九宫格金框资源（以 CSS 变量交给 skin.css 的 border-image 消费）
      document.body.prepend(createScene());
      previousFrame = document.documentElement.style.getPropertyValue('--roxy-composer-frame-art');
      document.documentElement.style.setProperty('--roxy-composer-frame-art', `url("${asset('composer-frame.webp')}")`);

      decorate = () => {
        // 侧栏纹样 + 宽度量测（与转义层同一口径：写「占位宽」，收起时为 0）
        const sidebar = document.querySelector('#left-sidebar');
        if (sidebar) {
          if (!sidebar.querySelector('[data-roxy-decoration="sidebar"]')) {
            sidebar.prepend(decorativeImage('sidebar', asset('sidebar-ornament.webp'), 'roxy-sidebar-plate'));
          }
          if (observedSidebar !== sidebar) {
            sidebarObserver?.disconnect();
            observedSidebar = sidebar;
            // 与转义层同口径：抽屉收起时占位为 0（拿盒子宽会让皮肤在收起态仍按让开一列推导，
            // 左边缘就留出一条没人画的底色）；量测取 border box，免得两侧口径差一个 padding。
            sidebarObserver = new ResizeObserver(() => {
              const occupied = sidebar.classList.contains('open')
                ? Math.round(sidebar.getBoundingClientRect().width)
                : 0;
              document.documentElement.style.setProperty('--dsh-sidebar-width', `${occupied}px`);
            });
            sidebarObserver.observe(sidebar);
          }
        }

        // 内容列偏移（原版用于让输入卡在 hero/active 两种相位下对齐）
        cancelAnimationFrame(frameRequest);
        frameRequest = requestAnimationFrame(() => {
          const content = document.querySelector('#message-list');
          const currentSidebar = document.querySelector('#left-sidebar');
          if (!content || !currentSidebar) return;
          const offset = Math.max(
            28,
            Math.round(content.getBoundingClientRect().left - currentSidebar.getBoundingClientRect().right),
          );
          document.documentElement.style.setProperty('--roxy-content-offset', `${offset}px`);
        });
      };

      decorate();
      observer = new MutationObserver(decorate);
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('resize', decorate);
    };

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });

    // 清理（皮肤卸载时由 dsh-theme 调用）
    return () => {
      document.removeEventListener('DOMContentLoaded', start);
      observer?.disconnect();
      sidebarObserver?.disconnect();
      cancelAnimationFrame(frameRequest);
      window.removeEventListener('resize', decorate);
      document.querySelectorAll(`[data-roxy-owner="${OWNER}"]`).forEach((el) => el.remove());
      document.documentElement.style.removeProperty('--dsh-sidebar-width');
      document.documentElement.style.removeProperty('--roxy-content-offset');
      if (previousFrame) document.documentElement.style.setProperty('--roxy-composer-frame-art', previousFrame);
      else document.documentElement.style.removeProperty('--roxy-composer-frame-art');
      if (document.body) delete document.body.dataset.roxySkin;
      active = false;
    };
  }, 'roxy-ui-skin');
}
