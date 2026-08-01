/**
 * browser-control skill 全链路回归测试
 * 运行：pnpm tsx scripts/test-browser-skill.ts
 *
 * 覆盖（直接调用工具 execute，不经 LLM）：
 *  1. browser_launch 启动真实浏览器（headless，避免弹窗）
 *  2. browser_navigate 导航到内嵌 data URL 测试页
 *  3. browser_extract 提取文本 / 链接 / 元信息
 *  4. browser_type 输入文本 + browser_click 点击按钮触发 JS
 *  5. browser_execute_js 读取交互结果（验证点击生效）
 *  6. browser_screenshot 截图保存
 *  7. browser_status 查看状态
 *  8. browser_close 关闭释放
 *  9. 重复 launch 单例复用（不重复创建）
 */
import { browserLaunch } from '../src/tools/inner_skills/browser-control/scripts/launch.js';
import { browserScroll } from '../src/tools/inner_skills/browser-control/scripts/scroll.js';
import { browserTabs, browserSwitchTab } from '../src/tools/inner_skills/browser-control/scripts/tabs.js';
import { browserNavigate } from '../src/tools/inner_skills/browser-control/scripts/navigate.js';
import { browserExtract } from '../src/tools/inner_skills/browser-control/scripts/extract.js';
import { browserType } from '../src/tools/inner_skills/browser-control/scripts/type.js';
import { browserClick } from '../src/tools/inner_skills/browser-control/scripts/click.js';
import { browserExecuteJs } from '../src/tools/inner_skills/browser-control/scripts/execute-js.js';
import { browserScreenshot } from '../src/tools/inner_skills/browser-control/scripts/screenshot.js';
import { browserStatus } from '../src/tools/inner_skills/browser-control/scripts/status.js';
import { browserClose } from '../src/tools/inner_skills/browser-control/scripts/close.js';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? ' -- ' + detail : '')); }
}

// 内嵌测试页：标题 + 输入框 + 按钮（点击后 JS 填充 #result）+ 链接
const TEST_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta name="description" content="浏览器技能测试页">
  <title>Browser Skill Test</title>
</head>
<body>
  <h1>Hello Browser Skill</h1>
  <input id="input" placeholder="输入内容">
  <button id="btn" onclick="document.getElementById('result').textContent='clicked:'+document.getElementById('input').value">点我</button>
  <div id="result">初始值</div>
  <a href="https://example.com">示例链接</a>
  <p class="para">这是一段测试文本段落。</p>
</body>
</html>`;

const DATA_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(TEST_HTML);

async function main() {
  console.log('== browser-control 全链路测试 ==\n');

  // ── 1. 启动浏览器 ──
  {
    const r = String(await browserLaunch.execute({ headless: true }));
    check('1a launch 返回已就绪', r.includes('浏览器已就绪'), r);
    check('1b 显示运行方式', /运行方式:/.test(r), r);
  }

  // ── 2. 重复 launch 单例复用 ──
  {
    const r1 = String(await browserLaunch.execute({ headless: true }));
    const r2 = String(await browserLaunch.execute({}));
    check('2a 重复 launch 不报错', r1.includes('浏览器已就绪') && r2.includes('浏览器已就绪'), r1 + ' | ' + r2);
  }

  // ── 3. 导航到测试页 ──
  {
    const r = String(await browserNavigate.execute({ url: DATA_URL, waitUntil: 'load' }));
    check('3a navigate 成功', r.includes('已导航到'), r);
    check('3b 返回页面标题', r.includes('Browser Skill Test'), r);
  }

  // ── 4. 提取文本 ──
  {
    const r = String(await browserExtract.execute({ mode: 'text' }));
    check('4a 提取到标题文本', r.includes('Hello Browser Skill'), r.slice(0, 200));
    check('4b 提取到段落文本', r.includes('这是一段测试文本段落'), r.slice(0, 200));
  }

  // ── 5. 提取链接 ──
  {
    const r = String(await browserExtract.execute({ mode: 'links' }));
    check('5a 提取到链接', r.includes('example.com'), r.slice(0, 300));
    check('5b 显示链接数量', /共 \d+ 个/.test(r), r.slice(0, 200));
  }

  // ── 6. 提取元信息 ──
  {
    const r = String(await browserExtract.execute({ mode: 'meta' }));
    check('6a meta 标题', r.includes('Browser Skill Test'), r);
    check('6b meta 描述', r.includes('浏览器技能测试页'), r);
    check('6c meta URL', r.includes('data:text/html'), r);
  }

  // ── 7. 输入文本 ──
  {
    const r = String(await browserType.execute({ selector: '#input', text: '你好世界' }));
    check('7a type 成功', r.includes('已向 #input 输入'), r);
    check('7b 字符数正确', r.includes('4 个字符'), r);
  }

  // ── 8. 点击按钮触发 JS ──
  {
    const r = String(await browserClick.execute({ selector: '#btn' }));
    check('8a click 成功', r.includes('已点击元素'), r);
    // 点击后 #result 被 JS 填充
    const js = String(await browserExecuteJs.execute({ script: `document.getElementById('result').textContent` }));
    check('8b JS 读取点击结果', js.includes('clicked:你好世界'), js);
  }

  // ── 9. 截图 ──
  {
    const r = String(await browserScreenshot.execute({ path: 'browser-shots/test-shot.png' }));
    check('9a 截图返回路径', r.includes('截图已保存'), r);
    check('9b 路径含 browser-shots', r.includes('browser-shots'), r);
    // 验证文件真实存在
    const fs = await import('node:fs');
    check('9c 截图文件存在', fs.existsSync('browser-shots/test-shot.png'), '');
  }

  // ── 10. 状态查询 ──
  {
    const r = String(await browserStatus.execute({}));
    check('10a status 运行中', r.includes('浏览器运行中'), r);
    check('10b status 显示标题', r.includes('Browser Skill Test'), r);
  }

  // ── 11. 滚动（先注入 3000px 高元素制造滚动空间，再测四种模式） ──
  {
    // 注入高元素
    await browserExecuteJs.execute({ script: `document.body.insertAdjacentHTML('beforeend', '<div id="tall" style="height:3000px;background:#eee">tall</div>')` });
    const before = String(await browserExecuteJs.execute({ script: `({ y: window.scrollY, maxY: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight })` }));
    const b = JSON.parse(before.slice(before.indexOf('{')));
    check('11a 页面可滚动空间 > 1000px', b.maxY > 1000, before);

    // down 600px
    const r1 = String(await browserScroll.execute({ direction: 'down', amount: 600 }));
    const y1 = /y=(\d+)/.exec(r1)?.[1] ?? '0';
    check('11b down 后 y 约 600', Math.abs(Number(y1) - 600) < 50, r1);

    // bottom 到底：文案显示“底部”且位置接近 maxY
    const r2 = String(await browserScroll.execute({ direction: 'bottom' }));
    const y2 = /y=(\d+)/.exec(r2)?.[1] ?? '0';
    check('11c bottom 文案为“底部”（不误报 amount）', r2.includes('滚动到底部') && !r2.includes('滚动 500px'), r2);
    check('11d bottom 后接近底部', Math.abs(Number(y2) - b.maxY) < 100, `y2=${y2}, maxY=${b.maxY}`);

    // up 300px
    const r3 = String(await browserScroll.execute({ direction: 'up', amount: 300 }));
    const y3 = /y=(\d+)/.exec(r3)?.[1] ?? '0';
    check('11e up 后 y 减小', Number(y3) < Number(y2), `y3=${y3}, y2=${y2}`);

    // top 回顶
    const r4 = String(await browserScroll.execute({ direction: 'top' }));
    const y4 = /y=(\d+)/.exec(r4)?.[1] ?? '-1';
    check('11f top 后 y=0（文案为“顶部”）', r4.includes('滚动到顶部') && Number(y4) === 0, r4);
  }

  // ── 11. 关闭浏览器 ──

  // ── 12. 多标签页：开新标签 → 列出 → 切换焦点 → 验证 extract 作用于新页 ──
  {
    // 用 JS 打开第二个标签页（不同标题/内容）
    const js = String(await browserExecuteJs.execute({ script: `window.open('data:text/html,<title>Tab2</title><h1>Second Tab</h1>', '_blank')` }));
    check('12a 开新标签成功', js.includes('执行成功'), js);
    // 短暂等待新标签就绪
    await new Promise((r) => setTimeout(r, 500));

    // 列出所有标签页
    const tabs = String(await browserTabs.execute({}));
    check('12b 列出 2 个标签页', tabs.includes('共 2 个标签页'), tabs);
    check('12c 标记焦点页', tabs.includes('▶ [0]') || tabs.includes('▶ [1]'), tabs);
    check('12d 显示新标签标题', tabs.includes('Tab2'), tabs);

    // 切换到标签页 [1]（新开的 Tab2）
    const sw = String(await browserSwitchTab.execute({ index: 1 }));
    check('12e 切换成功', sw.includes('已切换到标签页 [1]'), sw);
    check('12f 切换后标题为 Tab2', sw.includes('Tab2'), sw);

    // 切换后 extract 应作用于新焦点页
    const txt = String(await browserExtract.execute({ mode: 'text' }));
    check('12g 焦点页提取到 Tab2 内容', txt.includes('Second Tab'), txt.slice(0, 200));

    // 切回标签页 [0] 验证能恢复
    const sw2 = String(await browserSwitchTab.execute({ index: 0 }));
    check('12h 切回 [0] 成功', sw2.includes('已切换到标签页 [0]') && sw2.includes('Browser Skill Test'), sw2);
  }
  {
    const r = String(await browserClose.execute({}));
    check('11a close 成功', r.includes('浏览器已关闭'), r);
    // 关闭后再查状态
    const s = String(await browserStatus.execute({}));
    check('11b 关闭后 status 提示未启动', s.includes('浏览器未启动'), s);
  }

  // ── 12. 关闭后重新启动（可复用） ──
  {
    const r = String(await browserLaunch.execute({ headless: true }));
    check('12a 关闭后可重新启动', r.includes('浏览器已就绪'), r);
    await browserClose.execute({});
  }

  console.log('\n==============================');
  console.log('PASS ' + pass + ' / ' + (pass + fail));
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });






