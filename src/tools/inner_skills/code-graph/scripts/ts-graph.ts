/**
 * ts-graph.ts — 代码图谱核心引擎
 *
 * 借鉴 CodeWhale 的 LSP 集成思路（懒加载语言服务器 + 缓存 + 结果截断防刷屏），
 * 但用 TypeScript 编译器 API 做进程内分析，零外部进程依赖：
 *   - ts.Program 按工作区根懒加载并缓存（文件 mtime 变化才重建）
 *   - 符号/引用/调用链/依赖全部基于 AST + checker 语义分析
 *   - 大结果统一截断，防止刷爆模型上下文
 */
import ts from 'typescript';
import path from 'path';
import fs from 'fs';
import * as treeGraph from './tree-graph.js';

// ─── 语言分发：Java / C / C++ 走 tree-sitter 引擎 ─────────────

const TREE_LANG_EXT = new Set(['.java', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx']);

function isTreeLangFile(filePath: string): boolean {
  return TREE_LANG_EXT.has(path.extname(filePath).toLowerCase());
}

/** 项目根下是否存在 tree 语言源文件（供 find_references 不带 targetFile 时探测） */
function projectHasTreeFiles(rootDir: string): boolean {
  return treeGraph.presentLangs(path.resolve(rootDir)).length > 0;
}

// ─── Program 缓存（按目录根） ─────────────────────────────────

interface CachedProgram {
  program: ts.Program;
  /** 文件路径 → mtime，用于失效检测 */
  mtimes: Map<string, number>;
  createdAt: number;
}

const programCache = new Map<string, CachedProgram>();
const CACHE_MAX = 8; // 最多缓存 8 个根目录，避免内存膨胀

/** 获取（或重建）某目录根的 ts.Program。仅分析该根下的 .ts/.tsx/.js/.jsx。 */
export function getProgram(rootDir: string): ts.Program {
  const normalized = path.resolve(rootDir);
  const cached = programCache.get(normalized);
  if (cached && !isProgramStale(cached, normalized)) {
    return cached.program;
  }

  // 收集根目录下的 TS/JS 源文件
  const files = collectSourceFiles(normalized);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.Preserve,
  };
  const program = ts.createProgram(files, options);

  // 记录 mtime
  const mtimes = new Map<string, number>();
  for (const f of files) {
    try {
      mtimes.set(f, fs.statSync(f).mtimeMs);
    } catch {
      /* 文件可能已删除 */
    }
  }

  programCache.set(normalized, { program, mtimes, createdAt: Date.now() });
  // 简单 LRU：超过上限清空最老的
  if (programCache.size > CACHE_MAX) {
    const oldest = [...programCache.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt
    )[0];
    programCache.delete(oldest[0]);
  }
  return program;
}

function isProgramStale(cached: CachedProgram, rootDir: string): boolean {
  // 收集当前文件列表，与缓存对比
  const current = new Set(collectSourceFiles(rootDir));
  const cachedFiles = new Set(cached.mtimes.keys());
  if (current.size !== cachedFiles.size) return true;
  for (const f of current) {
    if (!cachedFiles.has(f)) return true;
    try {
      if (fs.statSync(f).mtimeMs !== cached.mtimes.get(f)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function collectSourceFiles(rootDir: string): string[] {
  const out: string[] = [];
  const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
    '.next', '.nuxt', '.cache', '.seek-agent', 'sessions', '.vite',
  ]);
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && /\.(ts|tsx|js|jsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out;
}

// ─── 路径解析辅助 ────────────────────────────────────────────

/** 从工作区根解析用户给的路径（相对或绝对），规范化 */
export function resolveToAbsolute(rootDir: string, rawPath: string): string {
  const p = path.isAbsolute(rawPath) ? rawPath : path.join(rootDir, rawPath);
  return path.resolve(p);
}

/** 取文件所在目录的根（向上找 package.json / tsconfig.json，找不到就用参数目录） */
export function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) ||
      fs.existsSync(path.join(dir, 'tsconfig.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/** 获取绝对路径对应的 sourceFile（不存在返回 undefined） */
function getSourceFile(program: ts.Program, absPath: string): ts.SourceFile | undefined {
  return program.getSourceFile(absPath);
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function isNodeModule(absPath: string): boolean {
  return absPath.includes(`${path.sep}node_modules${path.sep}`);
}

// ─── 符号提取 ────────────────────────────────────────────────

export interface SymbolInfo {
  name: string;
  kind: string; // function / class / method / property / interface / type / enum / variable / const / import
  startLine: number;
  endLine: number;
  signature: string;
  exported: boolean;
  container?: string; // 所属类/命名空间
}

/** 列出文件中所有顶层符号（函数/类/接口/类型/枚举/变量） */
export async function listSymbols(rootDir: string, filePath: string): Promise<{
  symbols: SymbolInfo[];
  file: string;
}> {
  const abs = resolveToAbsolute(rootDir, filePath);
  if (isTreeLangFile(abs)) return treeGraph.listSymbols(rootDir, abs);
  const program = getProgram(findProjectRoot(path.dirname(abs)));
  const sf = getSourceFile(program, abs);
  if (!sf) {
    throw new Error(`无法解析文件: ${filePath}（不在项目源文件集合中）`);
  }
  const symbols: SymbolInfo[] = [];
  const visit = (node: ts.Node) => {
    const text = sf.getFullText();
    const getSig = (_name: string, n: ts.Node) => {
      const start = n.getStart(sf);
      const end = Math.min(start + 160, n.getEnd());
      return text.slice(start, end).replace(/\s+/g, ' ').trim();
    };
    const isExported = (n: ts.Node) => {
      const mods = ts.getModifiers(n as ts.HasModifiers);
      return !!mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    };

    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({
        name: node.name.text,
        kind: 'function',
        startLine: lineOf(sf, node.getStart(sf)),
        endLine: lineOf(sf, node.getEnd()),
        signature: getSig(node.name.text, node),
        exported: isExported(node),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      symbols.push({
        name: node.name.text,
        kind: 'class',
        startLine: lineOf(sf, node.getStart(sf)),
        endLine: lineOf(sf, node.getEnd()),
        signature: getSig(node.name.text, node),
        exported: isExported(node),
      });
      // 类方法
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) {
          const mName = member.name && ts.isIdentifier(member.name)
            ? member.name.text
            : ts.isStringLiteral(member.name) ? member.name.text : '(computed)';
          symbols.push({
            name: mName,
            kind: ts.isMethodDeclaration(member) ? 'method' : 'property',
            startLine: lineOf(sf, member.getStart(sf)),
            endLine: lineOf(sf, member.getEnd()),
            signature: getSig(mName, member),
            exported: false,
            container: node.name.text,
          });
        }
      }
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      symbols.push({
        name: node.name.text,
        kind: 'interface',
        startLine: lineOf(sf, node.getStart(sf)),
        endLine: lineOf(sf, node.getEnd()),
        signature: getSig(node.name.text, node),
        exported: isExported(node),
      });
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      symbols.push({
        name: node.name.text,
        kind: 'type',
        startLine: lineOf(sf, node.getStart(sf)),
        endLine: lineOf(sf, node.getEnd()),
        signature: getSig(node.name.text, node),
        exported: isExported(node),
      });
    } else if (ts.isEnumDeclaration(node) && node.name) {
      symbols.push({
        name: node.name.text,
        kind: 'enum',
        startLine: lineOf(sf, node.getStart(sf)),
        endLine: lineOf(sf, node.getEnd()),
        signature: getSig(node.name.text, node),
        exported: isExported(node),
      });
    } else if (ts.isVariableStatement(node)) {
      // const / let / var 声明
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      const isLet = (node.declarationList.flags & ts.NodeFlags.Let) !== 0;
      const kind = isConst ? 'const' : isLet ? 'let' : 'variable';
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          symbols.push({
            name: d.name.text,
            kind,
            startLine: lineOf(sf, d.getStart(sf)),
            endLine: lineOf(sf, d.getEnd()),
            signature: getSig(d.name.text, d),
            exported: isExported(node),
          });
        }
      }
    } else if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      const names: string[] = [];
      if (clause.name) names.push(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push(`* as ${clause.namedBindings.name.text}`);
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            names.push(el.propertyName ? `${el.propertyName.text} as ${el.name.text}` : el.name.text);
          }
        }
      }
      for (const n of names) {
        symbols.push({
          name: n,
          kind: 'import',
          startLine: lineOf(sf, node.getStart(sf)),
          endLine: lineOf(sf, node.getEnd()),
          signature: n,
          exported: false,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { symbols, file: filePath };
}

/** 提取声明节点的名称（函数/类/接口/类型/枚举/方法/属性） */
function getDeclarationName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isClassDeclaration(node) && node.name) return node.name.text;
  if (ts.isInterfaceDeclaration(node) && node.name) return node.name.text;
  if (ts.isTypeAliasDeclaration(node) && node.name) return node.name.text;
  if (ts.isEnumDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isPropertyDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}


/** 读取某个符号的完整定义（签名 + jsdoc + 代码体） */
export async function readSymbol(rootDir: string, filePath: string, symbolName: string): Promise<string> {
  const abs = resolveToAbsolute(rootDir, filePath);
  if (isTreeLangFile(abs)) return treeGraph.readSymbol(rootDir, abs, symbolName);
  const program = getProgram(findProjectRoot(path.dirname(abs)));
  const sf = getSourceFile(program, abs);
  if (!sf) throw new Error(`无法解析文件: ${filePath}`);
  const text = sf.getFullText();

  // 支持 "ClassName.method" 格式
  let targetName = symbolName;
  let container: string | undefined;
  const dot = symbolName.lastIndexOf('.');
  if (dot !== -1) {
    container = symbolName.slice(0, dot);
    targetName = symbolName.slice(dot + 1);
  }

  let match: ts.Node | undefined;
  // 注意：createProgram 的 AST 不设置 parent 指针，容器用遍历参数传递
  const visit = (node: ts.Node, enclosingClass?: string) => {
    if (match) return;
    let name = getDeclarationName(node);
    // VariableDeclaration 藏在 VariableStatement 中，需单独提取
    if (!name && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      name = node.name.text;
    }
    if (!name) {
      ts.forEachChild(node, (c) => visit(c, enclosingClass));
      return;
    }
    // 进入类声明时，其成员归属该类
    const nextEnclosing = ts.isClassDeclaration(node) && node.name ? node.name.text : enclosingClass;
    const isInContainer = !container || enclosingClass === container;
    if (container && !isInContainer) {
      // 不在目标容器内：继续遍历（类声明本身要下钻找方法）
      ts.forEachChild(node, (c) => visit(c, nextEnclosing));
      return;
    }
    if (name === targetName && !container) {
      // 无容器时，顶层函数/类优先；类方法只在无匹配时兜底
      if (
        ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)
      ) {
        // 记录首个方法匹配但不立即返回，让 visit 继续找顶层
        if (!match) match = node; // 先占位，后续顶层会覆盖
        return;
      }
      match = node;
      return;
    }
    if (name === targetName && container && isInContainer) {
      match = node;
      return;
    }
    ts.forEachChild(node, (c) => visit(c, nextEnclosing));
  };
  visit(sf);

  // 顶层优先：如果占位的是方法，但存在同名顶层声明，覆盖
  if (match && (ts.isMethodDeclaration(match) || ts.isPropertyDeclaration(match))) {
    let topLevel: ts.Node | undefined;
    const scan = (node: ts.Node) => {
      if (topLevel) return;
      const name = getDeclarationName(node);
      if (name === targetName && !container && node.getStart(sf) !== match?.getStart(sf)) {
        topLevel = node;
      } else if (ts.isVariableStatement(node) && !container) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === targetName) {
            topLevel = node;
            break;
          }
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(sf);
    if (topLevel) match = topLevel;
  }

  if (!match) {
    throw new Error(`未找到符号 "${symbolName}"（文件 ${filePath}）`);
  }

  const start = match.getStart(sf);
  const end = match.getEnd();
  const body = text.slice(start, end);
  // jsdoc 注释
  let doc = '';
  const comments = ts.getLeadingCommentRanges(text, start);
  if (comments) {
    for (const c of comments) {
      const comment = text.slice(c.pos, c.end);
      if (comment.includes('@')) {
        doc = comment.split('\n').map((l) => l.replace(/^\s*\/?\*?\*?\/?\s*/, '').trim()).join('\n').trim();
      }
    }
  }
  const bodyLines = body.split('\n');
  const MAX_BODY = 200;
  let bodyOut = body;
  if (bodyLines.length > MAX_BODY) {
    bodyOut = bodyLines.slice(0, MAX_BODY).join('\n') + `\n... (已截断，共 ${bodyLines.length} 行)`;
  }
  const sig = text.slice(start, Math.min(start + 200, end)).replace(/\s+/g, ' ').trim();
  return [
    `── ${targetName} 定义 ──`,
    `文件: ${filePath}`,
    `位置: 第 ${lineOf(sf, start)} - ${lineOf(sf, end)} 行`,
    doc ? `\n📝 文档:\n${doc}` : '',
    `\n签名: ${sig}`,
    `\n代码体 (${bodyLines.length} 行):\n${bodyOut}`,
  ].filter(Boolean).join('\n');
}

// ─── 引用查找 ────────────────────────────────────────────────

export interface RefLocation {
  file: string;
  line: number;
  column: number;
  context: string;
}

/** 查找符号的所有引用（跨文件，基于 AST 名称匹配 + 语义近似） */
export async function findReferences(rootDir: string, symbolName: string, targetFile?: string): Promise<{
  refs: RefLocation[];
  total: number;
}> {
  // Java / C / C++ 文件或项目走 tree-sitter 引擎（语法级近似）
  if (targetFile && isTreeLangFile(resolveToAbsolute(rootDir, targetFile))) {
    return treeGraph.findReferences(rootDir, symbolName, resolveToAbsolute(rootDir, targetFile));
  }
  if (!targetFile && projectHasTreeFiles(rootDir)) {
    return treeGraph.findReferences(rootDir, symbolName);
  }
  const root = findProjectRoot(path.resolve(rootDir));
  const program = getProgram(root);
  const refs: RefLocation[] = [];
  const seen = new Set<string>();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || isNodeModule(sf.fileName)) continue;
    const text = sf.getFullText();
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === symbolName) {
        // 跳过声明本身（createProgram 无 parent 指针，先判空）
        const parent = node.parent;
        const decl = !!parent && (
          ts.isFunctionDeclaration(parent) && parent.name === node
          || ts.isClassDeclaration(parent) && parent.name === node
          || ts.isInterfaceDeclaration(parent) && parent.name === node
          || ts.isTypeAliasDeclaration(parent) && parent.name === node
          || ts.isEnumDeclaration(parent) && parent.name === node
          || ts.isVariableDeclaration(parent) && parent.name === node
          || (ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node
        );
        if (decl) return;
        const line = lineOf(sf, node.getStart(sf));
        const col = sf.getLineAndCharacterOfPosition(node.getStart(sf)).character + 1;
        const lineStart = sf.getLineStarts()[line - 1] ?? 0;
        const lineEnd = sf.getLineStarts()[line] ?? text.length;
        const context = text.slice(lineStart, lineEnd).trim().slice(0, 120);
        const key = `${sf.fileName}:${line}:${col}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({ file: sf.fileName, line, column: col, context });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  if (targetFile) {
    const abs = resolveToAbsolute(rootDir, targetFile);
    const filtered = refs.filter((r) => path.resolve(r.file) === abs);
    return { refs: filtered, total: filtered.length };
  }
  return { refs: refs.slice(0, 100), total: refs.length };
}

// ─── 调用链 ──────────────────────────────────────────────────

interface CallSite {
  file: string;
  line: number;
  callerName?: string; // 所在函数名（callers 用）
  calleeName?: string; // 被调用的函数名（callees 用）
  context: string;
}

function findFunctionDecls(program: ts.Program): Map<string, { file: string; node: ts.FunctionLikeDeclaration; container?: string }[]> {
  const map = new Map<string, { file: string; node: ts.FunctionLikeDeclaration; container?: string }[]>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || isNodeModule(sf.fileName)) continue;
    // 注意：createProgram 的 AST 无 parent 指针，类方法容器用遍历参数传递
    const visit = (node: ts.Node, enclosingClass?: string) => {
      if (
        ts.isFunctionDeclaration(node) && node.name ||
        ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) ||
        ts.isFunctionExpression(node) && node.name ||
        ts.isArrowFunction(node)
      ) {
        let name: string | undefined;
        let container: string | undefined;
        if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
        else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
          name = node.name.text;
          container = enclosingClass;
        } else if (ts.isFunctionExpression(node) && node.name) name = node.name.text;
        if (name) {
          const key = `${container ? container + '.' : ''}${name}`;
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({ file: sf.fileName, node, container });
        }
      }
      const nextEnclosing = ts.isClassDeclaration(node) && node.name ? node.name.text : enclosingClass;
      ts.forEachChild(node, (c) => visit(c, nextEnclosing));
    };
    visit(sf);
  }
  return map;
}

/** 提取函数体/方法体内的直接调用点 */
function extractCalls(sf: ts.SourceFile, node: ts.Node): CallSite[] {
  const text = sf.getFullText();
  const out: CallSite[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const line = lineOf(sf, n.getStart(sf));
      const lineStart = sf.getLineStarts()[line - 1] ?? 0;
      const lineEnd = sf.getLineStarts()[line] ?? text.length;
      out.push({
        file: sf.fileName,
        line,
        calleeName: n.expression.text,
        context: text.slice(lineStart, lineEnd).trim().slice(0, 100),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** 反向调用链：谁调用了该函数 */
export async function traceCallers(rootDir: string, _filePath: string, functionName: string): Promise<{
  callers: { file: string; line: number; callerName: string; context: string }[];
  total: number;
}> {
  if (isTreeLangFile(resolveToAbsolute(rootDir, _filePath))) {
    return treeGraph.traceCallers(rootDir, resolveToAbsolute(rootDir, _filePath), functionName);
  }
  const root = findProjectRoot(path.resolve(rootDir));
  const program = getProgram(root);
  const funcMap = findFunctionDecls(program);
  // 该函数的所有声明位置
  const decls = funcMap.get(functionName) ?? [];
  if (decls.length === 0) {
    throw new Error(`未找到函数 "${functionName}" 的声明`);
  }

  // 遍历所有文件，找调用该函数的调用点，并确定所在函数
  const callers: { file: string; line: number; callerName: string; context: string }[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || isNodeModule(sf.fileName)) continue;
    const text = sf.getFullText();
    const visit = (n: ts.Node, scope?: { name: string; start: number; end: number }) => {
      // 进入函数时更新 scope
      if (
        (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
        (n as ts.FunctionLikeDeclaration).name
      ) {
        const fn = n as ts.FunctionLikeDeclaration;
        const name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : '(anonymous)';
        const newScope = { name, start: n.getStart(sf), end: n.getEnd() };
        ts.forEachChild(n, (c) => visit(c, newScope));
        return;
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === functionName) {
        const line = lineOf(sf, n.getStart(sf));
        const lineStart = sf.getLineStarts()[line - 1] ?? 0;
        const lineEnd = sf.getLineStarts()[line] ?? text.length;
        const inDecl = scope && scope.start <= n.getStart(sf) && n.getStart(sf) <= scope.end;
        if (!inDecl || scope) {
          callers.push({
            file: sf.fileName,
            line,
            callerName: scope?.name ?? '(top-level)',
            context: text.slice(lineStart, lineEnd).trim().slice(0, 100),
          });
        }
      }
      ts.forEachChild(n, (c) => visit(c, scope));
    };
    visit(sf);
  }
  // 去重
  const seen = new Set<string>();
  const unique = callers.filter((c) => {
    const key = `${c.file}:${c.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { callers: unique.slice(0, 100), total: unique.length };
}

/** 正向调用链：该函数调用了谁 */
export async function traceCallees(rootDir: string, filePath: string, functionName: string): Promise<{
  callees: { name: string; file: string; line: number; context: string }[];
  total: number;
}> {
  const abs = resolveToAbsolute(rootDir, filePath);
  if (isTreeLangFile(abs)) return treeGraph.traceCallees(rootDir, abs, functionName);
  const root = findProjectRoot(path.dirname(abs));
  const program = getProgram(root);
  const sf = getSourceFile(program, abs);
  if (!sf) throw new Error(`无法解析文件: ${filePath}`);
  const funcMap = findFunctionDecls(program);

  // 找到该函数在目标文件中的声明
  const decls = (funcMap.get(functionName) ?? []).filter((d) => path.resolve(d.file) === abs);
  if (decls.length === 0) {
    // 尝试类方法
    const alt = [...funcMap.entries()].filter(([k, v]) =>
      k.endsWith('.' + functionName) && v.some((d) => path.resolve(d.file) === abs)
    );
    if (alt.length === 0) throw new Error(`未在 ${filePath} 中找到函数 "${functionName}" 的声明`);
    // 用第一个匹配的方法体
    const node = alt[0][1].find((d) => path.resolve(d.file) === abs)!;
    const calls = extractCalls(sf, node.node);
    const seen = new Set<string>();
    const unique = calls.filter((c) => {
      const key = `${c.calleeName}:${c.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      callees: unique.map((c) => ({ name: c.calleeName!, file: c.file, line: c.line, context: c.context })),
      total: unique.length,
    };
  }

  // 可能有多个同名声明的重载/同文件重复，合并它们体内的调用
  const calls: CallSite[] = [];
  for (const d of decls) {
    calls.push(...extractCalls(sf, d.node));
  }
  const seen = new Set<string>();
  const unique = calls.filter((c) => {
    const key = `${c.calleeName}:${c.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    callees: unique.map((c) => ({ name: c.calleeName!, file: c.file, line: c.line, context: c.context })),
    total: unique.length,
  };
}

/** 完整调用链（BFS，深度限制） */
export async function traceChain(rootDir: string, filePath: string, functionName: string, depth = 3): Promise<{
  chain: { name: string; file: string; line: number; depth: number }[];
  truncated: boolean;
}> {
  const abs = resolveToAbsolute(rootDir, filePath);
  if (isTreeLangFile(abs)) return treeGraph.traceChain(rootDir, abs, functionName, depth);
  const root = findProjectRoot(path.dirname(abs));
  const program = getProgram(root);

  const chain: { name: string; file: string; line: number; depth: number }[] = [];
  const visited = new Set<string>();
  let truncated = false;

  const queue: { name: string; file: string; depth: number }[] = [
    { name: functionName, file: abs, depth: 0 },
  ];
  visited.add(`${abs}:${functionName}`);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    // 达到最大深度：该层节点不展示也不展开（根 depth=0 始终展示）
    if (cur.depth >= depth) {
      truncated = true;
      continue;
    }
    chain.push({ name: cur.name, file: cur.file, line: 0, depth: cur.depth });
    // 找该函数在当前文件的声明
    const sf = getSourceFile(program, cur.file);
    if (!sf) continue;
    const funcMap = findFunctionDecls(program);
    const decls = (funcMap.get(cur.name) ?? []).filter((d) => path.resolve(d.file) === path.resolve(cur.file));
    if (decls.length === 0) continue;
    const calls = new Set<string>();
    for (const d of decls) {
      for (const c of extractCalls(sf, d.node)) {
        if (c.calleeName) calls.add(c.calleeName);
      }
    }
    for (const callee of calls) {
      const key = `${cur.file}:${callee}`;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ name: callee, file: cur.file, depth: cur.depth + 1 });
      }
    }
  }
  return { chain, truncated };
}

// ─── 文件依赖 ────────────────────────────────────────────────

export interface DepEdge {
  from: string;
  to: string;
  kind: 'import' | 'require' | 'dynamic' | 'type';
  line: number;
  external: boolean; // 是否是 node_modules 外部包
}

/** 文件依赖分析：列出文件 import/require 的所有模块（含解析后的实际文件） */
export async function fileDeps(rootDir: string, filePath: string): Promise<{
  deps: DepEdge[];
  file: string;
}> {
  const abs = resolveToAbsolute(rootDir, filePath);
  if (isTreeLangFile(abs)) return treeGraph.fileDeps(rootDir, abs);
  const root = findProjectRoot(path.dirname(abs));
  const program = getProgram(root);
  const sf = getSourceFile(program, abs);
  if (!sf) throw new Error(`无法解析文件: ${filePath}`);
  const deps: DepEdge[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const resolved = resolveModule(root, abs, spec);
      const external = isExternalSpecifier(spec);
      deps.push({
        from: filePath,
        to: resolved ?? spec,
        kind: spec.startsWith('type ') ? 'type' : 'import',
        line: lineOf(sf, node.getStart(sf)),
        external,
      });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      const spec = node.moduleReference.expression.text;
      const resolved = resolveModule(root, abs, spec);
      deps.push({
        from: filePath,
        to: resolved ?? spec,
        kind: 'import',
        line: lineOf(sf, node.getStart(sf)),
        external: isExternalSpecifier(spec),
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.Identifier &&
      (node.expression as ts.Identifier).text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const spec = node.arguments[0].text;
      const resolved = resolveModule(root, abs, spec);
      deps.push({
        from: filePath,
        to: resolved ?? spec,
        kind: 'require',
        line: lineOf(sf, node.getStart(sf)),
        external: isExternalSpecifier(spec),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // 去重
  const seen = new Set<string>();
  const unique = deps.filter((d) => {
    const key = `${d.to}:${d.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { deps: unique, file: filePath };
}

function isExternalSpecifier(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/') && !path.isAbsolute(spec);
}

/** 用 ts 模块解析把 specifier 解析为实际文件路径 */
function resolveModule(_root: string, fromFile: string, spec: string): string | undefined {
  const containing = path.dirname(fromFile);
  const result = ts.resolveModuleName(spec, fromFile, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: true,
  }, ts.sys);
  const resolved = result.resolvedModule?.resolvedFileName;
  if (!resolved) return undefined;
  return path.relative(containing, resolved).replace(/\\/g, '/');
}

// ─── 影响面分析 ──────────────────────────────────────────────

export interface RadiusHit {
  file: string;
  line: number;
  kind: 'import' | 'reference' | 'direct';
  context: string;
}

/** 影响面分析：修改某文件（或其中某符号）会影响哪些文件 */
export async function blastRadius(rootDir: string, filePath: string, symbolName?: string): Promise<{
  hits: RadiusHit[];
  files: string[];
  total: number;
}> {
  const abs = resolveToAbsolute(rootDir, filePath);
  if (isTreeLangFile(abs)) return treeGraph.blastRadius(rootDir, abs, symbolName);
  const root = findProjectRoot(path.dirname(abs));
  const program = getProgram(root);

  // 1. 反向依赖：谁 import 了这个文件
  const relFrom = path.relative(root, abs).replace(/\\/g, '/');
  const hits: RadiusHit[] = [];
  const seen = new Set<string>();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || isNodeModule(sf.fileName) || path.resolve(sf.fileName) === abs) continue;
    const text = sf.getFullText();
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        const resolved = resolveModule(root, sf.fileName, spec);
        // 解析后文件匹配，或 spec 直接匹配相对路径
        const resolvedAbs = resolved ? path.resolve(path.dirname(sf.fileName), resolved) : undefined;
        if (resolvedAbs === abs || spec.replace(/\\/g, '/') === relFrom.replace(/\.(ts|tsx|js|jsx)$/, '')) {
          const line = lineOf(sf, node.getStart(sf));
          const key = `${sf.fileName}:${line}:import`;
          if (!seen.has(key)) {
            seen.add(key);
            const lineStart = sf.getLineStarts()[line - 1] ?? 0;
            const lineEnd = sf.getLineStarts()[line] ?? text.length;
            hits.push({
              file: sf.fileName,
              line,
              kind: 'import',
              context: text.slice(lineStart, lineEnd).trim().slice(0, 100),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // 2. 如果指定了符号：谁引用了该符号（且不在本文件）
  if (symbolName) {
    const refs = await findReferences(rootDir, symbolName);
    for (const r of refs.refs) {
      if (path.resolve(r.file) === abs) continue;
      const key = `${r.file}:${r.line}:ref`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ file: r.file, line: r.line, kind: 'reference', context: r.context });
      }
    }
  }

  const files = [...new Set(hits.map((h) => h.file))];
  return { hits: hits.slice(0, 100), files, total: hits.length };
}


































