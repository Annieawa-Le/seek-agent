import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import net from 'net';
import { spawn } from 'child_process';
import { getCwd } from '../../../../workdir';

/**
 * 检查指定端口是否可用
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 从首选端口开始查找可用端口
 */
async function findAvailablePort(preferred: number): Promise<number> {
  let port = preferred;
  for (let i = 0; i < 50; i++) {
    if (await isPortAvailable(port)) return port;
    port++;
  }
  throw new Error('无法找到可用端口（尝试了 50 个端口均被占用）');
}

/**
 * 在 HTML 的 <head> 起始位置注入 console 捕获脚本，确保在任何业务脚本之前执行。
 * 脚本重写 console.log/warn/error/info/debug，
 * 并捕获未处理的 JS 异常和 Promise rejection，
 * 通过 XMLHttpRequest 将日志发送到本地服务器的 /__console__ 端点。
 */
function injectConsoleCapture(html: string): string {
  const script = [
    '<script>',
    '(function(){',
    'if(window.__consoleCaptureInjected)return;',
    'window.__consoleCaptureInjected=true;',
    'function _sl(l,a){',
    'try{',
    'var m=[];',
    'for(var i=0;i<a.length;i++){',
    'try{m.push(typeof a[i]==="object"?JSON.stringify(a[i]):String(a[i]));}',
    'catch(e){m.push(String(a[i]));}',
    '}',
    'var u=window.location.origin+"/__console__";',
    'var x=new XMLHttpRequest();',
    'x.open("POST",u,true);',
    'x.setRequestHeader("Content-Type","application/json");',
    'x.send(JSON.stringify({level:l,messages:m,timestamp:Date.now()}));',
    '}catch(e){}',
    '}',
    'var c=window.console;',
    'var _l=c.log,_w=c.warn,_e=c.error,_i=c.info,_d=c.debug;',
    'c.log=function(){_sl("log",arguments);_l.apply(c,arguments);};',
    'c.warn=function(){_sl("warn",arguments);_w.apply(c,arguments);};',
    'c.error=function(){_sl("error",arguments);_e.apply(c,arguments);};',
    'c.info=function(){_sl("info",arguments);_i.apply(c,arguments);};',
    'c.debug=function(){_sl("debug",arguments);_d.apply(c,arguments);};',
    'window.addEventListener("error",function(e){_sl("error",[e.message?e.message:"Resource error: "+(e.target?e.target.src||e.target.href||"unknown":"unknown")]);});',
    'window.addEventListener("unhandledrejection",function(e){_sl("error",["Unhandled Promise:",String(e.reason)]);});',
    '})();',
    '</script>',
  ].join('\n');

  // 插入到 <head> 起始位置，确保在一切业务脚本之前执行
  const headOpenMatch = html.match(/<head[^>]*>/i);
  if (headOpenMatch) {
    const idx = headOpenMatch.index! + headOpenMatch[0].length;
    return html.slice(0, idx) + '\n' + script + html.slice(idx);
  }
  // 没有 <head>，尝试在 <html> 后插入
  const htmlOpenMatch = html.match(/<html[^>]*>/i);
  if (htmlOpenMatch) {
    const idx = htmlOpenMatch.index! + htmlOpenMatch[0].length;
    return html.slice(0, idx) + '\n' + script + html.slice(idx);
  }
  // 回退：在 <body> 前插入
  const bodyOpenMatch = html.match(/<body[^>]*>/i);
  if (bodyOpenMatch) {
    const idx = bodyOpenMatch.index! + bodyOpenMatch[0].length;
    return html.slice(0, idx) + '\n' + script + html.slice(idx);
  }
  // 最坏情况：插到最前面
  return script + '\n' + html;
}

/**
 * 请求服务器的 /__console__/flush 端点，获取当前累积的所有控制台日志并清空队列。
 */
async function fetchConsoleLogs(port: number): Promise<any[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__console__/flush`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return (await res.json()) as any[];
  } catch {
    // 服务器可能还未就绪或已关闭
  }
  return [];
}

export const runPage = tool({
  description: `将 HTML 内容启动为本地调试页面。接收 HTML 代码字符串或文件路径，启动临时 HTTP 服务器并在浏览器中打开页面。页面中的 console.log/warn/error/info/debug 输出会被自动捕获并返回。`,
  inputSchema: z.object({
    htmlSource: z
      .string()
      .describe(
        'HTML 代码字符串内容，或 HTML 文件的路径（相对于工作区根目录）',
      ),
    port: z
      .number()
      .optional()
      .default(3000)
      .describe('指定本地服务器端口号（默认 3000，如被占用会自动递增）'),
  }),
  execute: async ({ htmlSource, port }): Promise<string> => {
    const preferredPort = port ?? 3000;

    // ── 1. 获取 HTML 内容 ──────────────────────────
    let htmlContent: string;
    let sourceLabel: string;

    // 预检：如果以 '<' 开头（允许前导空白），大概率是内联 HTML，直接作为内容处理
    if (/^\s*</.test(htmlSource)) {
      htmlContent = htmlSource;
      sourceLabel = '内联 HTML';
    } else {
      // 否则尝试作为文件路径解析（基于当前工作目录）
      try {
        const resolvedPath = path.resolve(getCwd(), htmlSource);
        const stat = await fs.stat(resolvedPath);
        if (stat.isFile()) {
          htmlContent = await fs.readFile(resolvedPath, 'utf-8');
          sourceLabel = `文件: ${resolvedPath}`;
        } else {
          htmlContent = htmlSource;
          sourceLabel = '内联 HTML';
        }
      } catch {
        // 文件不存在，回退为内联 HTML
        htmlContent = htmlSource;
        sourceLabel = '内联 HTML';
      }
    }

    // ── 2. 注入 console 捕获脚本 ──────────────────
    const hasCaptureScript = htmlContent.includes('__consoleCaptureInjected');
    if (!hasCaptureScript) {
      htmlContent = injectConsoleCapture(htmlContent);
    }

    // ── 3. 写入临时文件 ────────────────────────────
    const tmpDir = path.join(os.tmpdir(), 'html-toolkit');
    await fs.mkdir(tmpDir, { recursive: true });

    // 从 <title> 提取文件名
    const titleMatch = htmlContent.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i,
    );
    const safeName = titleMatch
      ? titleMatch[1]
          .trim()
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\s+/g, '_')
          .slice(0, 40)
      : 'preview';
    const fileName = `${safeName || 'preview'}.html`;
    const filePath = path.join(tmpDir, fileName);
    await fs.writeFile(filePath, htmlContent, 'utf-8');

    // ── 4. 查找可用端口 ────────────────────────────
    const availablePort = await findAvailablePort(preferredPort);

    // ── 5. 生成 HTTP 服务器脚本（内置 console 日志收集 API） ──
    const serverScriptPath = path.join(tmpDir, 'server.mjs');
    const serverScript = [
      `import http from 'http';`,
      `import fs from 'fs';`,
      `import path from 'path';`,
      `import { fileURLToPath } from 'url';`,
      ``,
      `const __dirname = path.dirname(fileURLToPath(import.meta.url));`,
      `const PORT = ${availablePort};`,
      `const BASE_FILE = ${JSON.stringify(fileName)};`,
      ``,
      `const MIME = {`,
      `  '.html': 'text/html; charset=utf-8',`,
      `  '.css':  'text/css; charset=utf-8',`,
      `  '.js':   'application/javascript; charset=utf-8',`,
      `  '.mjs':  'application/javascript; charset=utf-8',`,
      `  '.json': 'application/json',`,
      `  '.png':  'image/png',`,
      `  '.jpg':  'image/jpeg',`,
      `  '.jpeg': 'image/jpeg',`,
      `  '.gif':  'image/gif',`,
      `  '.svg':  'image/svg+xml',`,
      `  '.ico':  'image/x-icon',`,
      `  '.woff': 'font/woff',`,
      `  '.woff2':'font/woff2',`,
      `  '.wasm': 'application/wasm',`,
      `};`,
      ``,
      `// ── Console 日志收集 ──`,
      `const consoleLogs = [];`,
      ``,
      `const server = http.createServer((req, res) => {`,
      `  // Console API: 接收日志`,
      `  if (req.method === 'POST' && req.url === '/__console__') {`,
      `    let body = '';`,
      `    req.on('data', chunk => body += chunk);`,
      `    req.on('end', () => {`,
      `      try {`,
      `        const entry = JSON.parse(body);`,
      `        consoleLogs.push(entry);`,
      `      } catch (e) {}`,
      `      res.writeHead(200, { 'Content-Type': 'application/json' });`,
      `      res.end('{"ok":true}');`,
      `    });`,
      `    return;`,
      `  }`,
      ``,
      `  // Console API: 获取并清空日志`,
      `  if (req.method === 'GET' && req.url === '/__console__/flush') {`,
      `    const logs = consoleLogs.splice(0);`,
      `    res.writeHead(200, { 'Content-Type': 'application/json' });`,
      `    res.end(JSON.stringify(logs));`,
      `    return;`,
      `  }`,
      ``,
      `  // ── 静态文件服务 ──`,
      `  const reqPath = req.url === '/' ? BASE_FILE : decodeURIComponent(req.url);`,
      `  let filePath = path.join(__dirname, reqPath);`,
      ``,
      `  if (!filePath.startsWith(__dirname)) {`,
      `    res.writeHead(403, { 'Content-Type': 'text/plain' });`,
      `    return res.end('Forbidden');`,
      `  }`,
      ``,
      `  const ext = path.extname(filePath);`,
      `  const contentType = MIME[ext] || 'application/octet-stream';`,
      ``,
      `  fs.readFile(filePath, (err, data) => {`,
      `    if (err) {`,
      `      if (err.code === 'ENOENT') {`,
      `        res.writeHead(404, { 'Content-Type': 'text/html' });`,
      `        return res.end('<h1>404 - Not Found</h1>');`,
      `      }`,
      `      res.writeHead(500, { 'Content-Type': 'text/plain' });`,
      `      return res.end('Internal Server Error');`,
      `    }`,
      `    res.writeHead(200, { 'Content-Type': contentType });`,
      `    res.end(data);`,
      `  });`,
      `});`,
      ``,
      `server.listen(PORT, '127.0.0.1', () => {`,
      `  console.log('SERVER_READY:' + PORT);`,
      `});`,
    ].join('\n');

    await fs.writeFile(serverScriptPath, serverScript, 'utf-8');

    // ── 6. 启动服务器子进程 ────────────────────────
    const serverProcess = spawn('node', [serverScriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });

    // 等待服务器就绪信号
    const actualPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('服务器启动超时（8 秒）'));
      }, 8000);

      let buffer = '';
      serverProcess.stdout.on('data', (data: Buffer) => {
        buffer += data.toString();
        const match = buffer.match(/SERVER_READY:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(parseInt(match[1], 10));
        }
      });

      serverProcess.stderr.on('data', (data: Buffer) => {
        console.error('[html-toolkit:server]', data.toString().trim());
      });

      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`服务器进程启动失败: ${err.message}`));
      });
    });

    const url = `http://localhost:${actualPort}`;

    // ── 7. 自动打开浏览器（Windows） ───────────────
    try {
      spawn('cmd', ['/c', 'start', '', url], {
        shell: true,
        detached: true,
      });
    } catch {
      // 浏览器打开非必须，静默忽略
    }

    // ── 8. 多阶段轮询获取 console 日志 ────────────
    // 分多个时间点 flush，最大程度捕获初始化期间和延迟输出的日志
    const allLogs: any[] = [];
    const seenKeys = new Set<string>();
    const pollDelays = [500, 1500, 3000]; // ms
    for (const delay of pollDelays) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const logs = await fetchConsoleLogs(actualPort);
      for (const entry of logs) {
        const key = `${entry.level}|${(entry.messages || []).join('|')}|${entry.timestamp}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          allLogs.push(entry);
        }
      }
    }

    // 解除子进程引用，让父进程可独立退出
    serverProcess.unref();

    // ── 9. 组装返回信息 ────────────────────────────
    const lines: string[] = [
      `✅ HTML 调试页面已启动！`,
      ``,
      `  来源: ${sourceLabel}`,
      `  地址: ${url}`,
      `  文件: ${filePath}`,
      `  端口: ${actualPort}`,
      `  PID:  ${serverProcess.pid}`,
    ];

    if (allLogs.length > 0) {
      lines.push(``, `  ── 控制台输出 ──`);
      for (const entry of allLogs) {
        const level: string = entry.level || 'log';
        const msg: string = (entry.messages || []).join(' ');
        const icon: Record<string, string> = {
          log: '📋', warn: '⚠️', error: '❌', info: 'ℹ️', debug: '🔍',
        };
        lines.push(`  ${icon[level] || '📋'} [${level.toUpperCase()}] ${msg}`);
      }
    }

    lines.push(
      `浏览器已自动打开。console.log/warn/error/info/debug、未捕获异常(throw)和未处理的 Promise rejection 均已自动捕获。`,
      `页面后续交互产生的日志可通过以下端点持续查看：${url}/__console__/flush`,
      `调试完毕请手动关闭进程：taskkill /F /PID ${serverProcess.pid}`,
    );

    return lines.join('\n');
  },
});






