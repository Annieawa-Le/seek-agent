/**
 * browser-control skill 的浏览器单例管理器
 * 核心价值：浏览器实例在进程内常驻（懒加载单例），AI 可以多轮操作同一个页面，
 * 而不是每次抓取都新建连接。真实浏览器指纹（系统 Edge/Chrome）天然抗反爬。
 */
import { chromium, type Browser, type BrowserContext, type Page, type ViewportSize } from 'playwright-core';

export interface LaunchConfig {
  headless?: boolean;
  channel?: string;
  viewport?: { width: number; height: number };
  userDataDir?: string;
}

export interface LaunchResult {
  channel: string;
  headless: boolean;
  pages: number;
}

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private usedChannel = '';
  private usedHeadless = false;

  /** 浏览器是否已启动 */
  get isRunning(): boolean {
    return this.context !== null || this.browser !== null;
  }

  /** 获取当前 page；未启动时抛错提示先调用 browser_launch */
  getPage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error('浏览器尚未启动或页面已关闭，请先调用 browser_launch 启动浏览器');
    }
    return this.page;
  }

  /** 获取当前状态快照（同步字段） */
  getStatusInfo(): {
    running: boolean;
    channel: string;
    headless: boolean;
    pageCount: number;
    url: string;
  } {
    let pageCount = 0;
    let url = '';
    if (this.context) {
      pageCount = this.context.pages().length;
    }
    if (this.page && !this.page.isClosed()) {
      try {
        url = this.page.url();
      } catch {
        /* 页面可能正在导航 */
      }
    }
    return {
      running: this.isRunning,
      channel: this.usedChannel,
      headless: this.usedHeadless,
      pageCount,
      url,
    };
  }

  /** 异步获取页面标题（失败返回空串） */
  async getTitle(): Promise<string> {
    try {
      if (this.page && !this.page.isClosed()) {
        return await this.page.title();
      }
    } catch {
      /* 忽略 */
    }
    return '';
  }

  /** 列出所有标签页（含标题），标记当前焦点页 */
  async listPages(): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
    if (!this.context) return [];
    const pages = this.context.pages();
    const result: Array<{ index: number; url: string; title: string; active: boolean }> = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      let title = '';
      try { title = await p.title(); } catch { /* 页面可能正在导航 */ }
      result.push({
        index: i,
        url: p.url(),
        title,
        active: p === this.page && !p.isClosed(),
      });
    }
    return result;
  }

  /** 切换焦点页（index 基于 listPages 返回的序号） */
  async switchPage(index: number): Promise<{ index: number; url: string; title: string }> {
    if (!this.context) throw new Error('浏览器尚未启动，请先调用 browser_launch');
    const pages = this.context.pages();
    const target = pages[index];
    if (!target) throw new Error(`标签页不存在: index=${index}（当前共 ${pages.length} 个标签页）`);
    if (target.isClosed()) throw new Error(`标签页已关闭: index=${index}`);
    this.page = target;
    try { await target.bringToFront(); } catch { /* 部分环境不支持 */ }
    const title = await target.title().catch(() => '');
    return { index, url: target.url(), title };
  }

  /**
   * 启动浏览器（单例：已启动则直接返回状态，不重复创建）。
   * 启动策略按顺序尝试：指定 channel → msedge → chrome → Edge/Chrome 可执行文件 → 默认。
   */
  async launch(config: LaunchConfig = {}): Promise<LaunchResult> {
    if (this.isRunning) {
      return this.getLaunchResult();
    }

    const headless = config.headless ?? false;
    const viewport: ViewportSize = config.viewport ?? { width: 1280, height: 720 };
    const userDataDir = config.userDataDir;
    const errors: string[] = [];

    // 构造候选 channel 列表（去重，指定 channel 优先）
    const channels: string[] = [];
    if (config.channel) channels.push(config.channel);
    for (const c of ['msedge', 'chrome']) {
      if (!channels.includes(c)) channels.push(c);
    }

    // 1) 尝试 channel
    for (const channel of channels) {
      try {
        await this.tryLaunch({ headless, viewport, channel }, userDataDir);
        return this.getLaunchResult();
      } catch (e) {
        errors.push(`channel '${channel}': ${firstLine(e)}`);
      }
    }

    // 2) 尝试可执行文件
    for (const executablePath of [EDGE_EXE, CHROME_EXE]) {
      try {
        await this.tryLaunch({ headless, viewport, executablePath }, userDataDir);
        return this.getLaunchResult();
      } catch (e) {
        errors.push(`executable '${executablePath}': ${firstLine(e)}`);
      }
    }

    // 3) 默认 launch（playwright 自带浏览器）
    try {
      await this.tryLaunch({ headless, viewport }, userDataDir);
      return this.getLaunchResult();
    } catch (e) {
      errors.push(`默认: ${firstLine(e)}`);
    }

    throw new Error(
      `浏览器启动失败（已尝试 ${channels.length + 2 + 1} 种方式）：\n${errors.join('\n')}\n\n请确认系统已安装 Edge 或 Chrome 浏览器。`
    );
  }

  /** 用给定 options 启动（channel / executablePath / 默认三选一） */
  private async tryLaunch(options: Record<string, unknown>, userDataDir?: string): Promise<void> {
    const common = {
      headless: options.headless,
      viewport: options.viewport,
      args: ['--disable-blink-features=AutomationControlled'],
    } as any;

    if (userDataDir) {
      // 持久化用户数据目录（登录态等跨会话保留）
      const context = await chromium.launchPersistentContext(userDataDir, {
        ...common,
        ...(options.channel ? { channel: options.channel } : {}),
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      });
      this.context = context;
      this.usedChannel = describeLaunch(options);
      const pages = context.pages();
      this.page = pages[0] ?? (await context.newPage());
    } else {
      const browser = await chromium.launch({
        ...common,
        ...(options.channel ? { channel: options.channel } : {}),
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      });
      this.browser = browser;
      this.usedChannel = describeLaunch(options);
      const context = await browser.newContext({ viewport: options.viewport as ViewportSize });
      this.context = context;
      this.page = await context.newPage();
    }
    this.usedHeadless = Boolean(options.headless);
  }

  private getLaunchResult(): LaunchResult {
    return {
      channel: this.usedChannel,
      headless: this.usedHeadless,
      pages: this.context ? this.context.pages().length : 0,
    };
  }

  /** 关闭浏览器并释放单例引用 */
  async close(): Promise<void> {
    try {
      if (this.context) await this.context.close().catch(() => {});
    } catch {
      /* 忽略 */
    }
    try {
      if (this.browser) await this.browser.close().catch(() => {});
    } catch {
      /* 忽略 */
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.usedChannel = '';
    this.usedHeadless = false;
  }
}

function describeLaunch(options: Record<string, unknown>): string {
  if (options.channel) return `channel:${options.channel}`;
  if (options.executablePath) return String(options.executablePath);
  return '默认浏览器';
}

function firstLine(e: unknown): string {
  const msg = (e as Error).message || String(e);
  return msg.split('\n')[0];
}

/** 全局单例 */
export const browserManager = new BrowserManager();

