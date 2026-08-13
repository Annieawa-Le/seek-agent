/**
 * tree-graph.ts — 代码图谱 tree-sitter 引擎（Java / C / C++）
 *
 * 基于 web-tree-sitter WASM 解析器，零外部进程依赖，语法级精度
 * （无类型解析，同名/重载会近似匹配）。输出结构与 ts-graph.ts 对齐，
 * 供 code-graph 8 工具统一消费。WebAssembly 按语言懒加载并缓存。
 *
 * 支持的节点类型要点：
 *   Java: class/interface/enum/record 声明、method/constructor 声明、
 *         field_declaration、method_invocation、object_creation_expression、import
 *   C:    function_definition、function_declarator（含原型）、declaration、
 *         struct/union/enum/typedef、preproc_def/preproc_function_def、call_expression、preproc_include
 */
import { Parser, Language, Node as TNode, Tree } from 'web-tree-sitter';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ─── 语言注册 ────────────────────────────────────────────────

export type LangId = 'java' | 'c' | 'cpp';

const LANG_BY_EXT: Record<string, LangId> = {
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
};

/** 文件扩展名 → 语言；不支持返回 null */
export function langForFile(filePath: string): LangId | null {
  return LANG_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

const EXTS_BY_LANG: Record<LangId, string[]> = {
  java: ['.java'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
};

// ─── WASM 初始化（懒加载 + 缓存） ────────────────────────────

let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const runtimeWasm = require.resolve('web-tree-sitter/tree-sitter.wasm');
      await Parser.init({ locateFile: () => runtimeWasm });
    })();
  }
  return initPromise;
}

const langCache = new Map<LangId, Language>();

async function getLang(lang: LangId): Promise<Language> {
  let L = langCache.get(lang);
  if (!L) {
    await ensureInit();
    const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${lang}.wasm`);
    L = await Language.load(wasmPath);
    langCache.set(lang, L);
  }
  return L;
}

// ─── 语法树 + 源文本缓存（按文件 mtime 失效） ────────────────

interface CachedParse {
  mtime: number;
  tree: Tree;
  text: string;
}

const parseCache = new Map<string, CachedParse>();

/** 解析单个文件为语法树；非 Java/C/C++ 返回 null */
export async function parseFile(filePath: string): Promise<{ tree: Tree; text: string } | null> {
  if (!langForFile(filePath)) return null;
  let mtime: number;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
  const cached = parseCache.get(filePath);
  if (cached && cached.mtime === mtime) {
    return { tree: cached.tree, text: cached.text };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const lang = await getLang(langForFile(filePath)!); // 内部先 ensureInit
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(text)!;
  parseCache.set(filePath, { mtime, tree, text });
  return { tree, text };
}

// ─── 目录扫描 ────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.seek-agent', 'sessions', '.vite', 'target', 'bin', 'obj',
]);

function collectLangFiles(rootDir: string, lang: LangId): string[] {
  const exts = EXTS_BY_LANG[lang];
  const out: string[] = [];
  const walkDir = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walkDir(full);
      } else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walkDir(rootDir);
  return out;
}

/** 项目里实际存在的 tree 语言（供不带 targetFile 的跨文件查询使用） */
export function presentLangs(rootDir: string): LangId[] {
  const langs: LangId[] = [];
  for (const lang of ['java', 'c', 'cpp'] as LangId[]) {
    if (collectLangFiles(rootDir, lang).length > 0) langs.push(lang);
  }
  return langs;
}

// ─── 通用遍历 / 提取辅助 ─────────────────────────────────────

/** web-tree-sitter 类型定义里 namedChildren 元素可能为 null，过滤掉 */
function kids(node: TNode): TNode[] {
  return node.namedChildren.filter((c): c is TNode => c !== null);
}

/** 取字段子节点；tree-sitter-java 的 import path 无字段名，回退按类型找 */
function fieldOr(node: TNode, field: string, types?: string[]): TNode | null {
  const f = node.childForFieldName(field);
  if (f) return f;
  if (types) {
    for (const c of kids(node)) {
      if (types.includes(c.type)) return c;
    }
  }
  return null;
}

function importPathNode(node: TNode): TNode | null {
  return fieldOr(node, 'path', ['scoped_identifier', 'identifier']);
}

function walk(node: TNode | null, fn: (n: TNode) => boolean | void): void {
  if (!node) return;
  if (fn(node) === false) return;
  for (const c of kids(node)) walk(c, fn);
}

const lineOf = (n: TNode) => n.startPosition.row + 1;
const colOf = (n: TNode) => n.startPosition.column + 1;

function signatureOf(text: string, node: TNode, max = 160): string {
  const start = node.startIndex;
  const end = Math.min(start + max, node.endIndex);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function lineTextOf(text: string, line: number, max = 120): string {
  const lines = text.split('\n');
  return (lines[line - 1] ?? '').trim().slice(0, max);
}

/** 节点所在最近函数（用于 traceCallers 的 callerName） */
function enclosingFunction(node: TNode, lang: LangId): string {
  let n = node.parent;
  while (n) {
    if (lang === 'java') {
      if (n.type === 'method_declaration' || n.type === 'constructor_declaration') {
        return n.childForFieldName('name')?.text ?? '(constructor)';
      }
    } else if (n.type === 'function_definition') {
      return declaratorName(n) ?? '(anonymous)';
    }
    n = n.parent;
  }
  return '(top-level)';
}

/** C 声明器链中提取名字（跳过参数列表里的 identifier） */
function declaratorName(decl: TNode): string | null {
  const node = decl.type === 'function_definition' || decl.type === 'declaration'
    ? decl.childForFieldName('declarator') ?? decl
    : decl;
  const find = (n: TNode): string | null => {
    if (n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier') return n.text;
    if (n.type === 'parameter_list' || n.type === 'parameter_declaration') return null;
    for (const c of kids(n)) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  return find(node);
}

function hasFunctionDeclarator(decl: TNode): boolean {
  let found = false;
  const find = (n: TNode): void => {
    if (found) return;
    if (n.type === 'function_declarator') {
      found = true;
      return;
    }
    for (const c of kids(n)) find(c);
  };
  find(decl);
  return found;
}

// ─── list_symbols ────────────────────────────────────────────

export interface SymbolInfo {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature: string;
  exported: boolean;
  container?: string;
}

const JAVA_TYPE_KIND: Record<string, string> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'record',
  annotation_type_declaration: 'annotation',
};

function javaHasModifier(node: TNode, mod: string): boolean {
  const mods = node.childForFieldName('modifiers');
  return !!mods && new RegExp(`\\b${mod}\\b`).test(mods.text);
}

function javaSymbols(text: string, tree: Tree): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const visitClass = (node: TNode, container?: string) => {
    const name = node.childForFieldName('name')?.text;
    if (!name) return;
    const kind = JAVA_TYPE_KIND[node.type] ?? 'class';
    symbols.push({
      name, kind,
      startLine: lineOf(node), endLine: node.endPosition.row + 1,
      signature: signatureOf(text, node),
      exported: javaHasModifier(node, 'public'),
      container,
    });
    const outer = container ? `${container}.${name}` : name;
    const body = node.childForFieldName('body');
    if (!body) return;
    for (const m of kids(body)) {
      if (m.type === 'method_declaration' || m.type === 'constructor_declaration') {
        const mName = m.childForFieldName('name')?.text ?? name;
        symbols.push({
          name: mName, kind: 'method',
          startLine: lineOf(m), endLine: m.endPosition.row + 1,
          signature: signatureOf(text, m),
          exported: javaHasModifier(m, 'public'),
          container: outer,
        });
      } else if (m.type === 'field_declaration') {
        for (const d of kids(m)) {
          if (d.type !== 'variable_declarator') continue;
          const vName = d.childForFieldName('name')?.text;
          if (!vName) continue;
          symbols.push({
            name: vName, kind: 'property',
            startLine: lineOf(d), endLine: d.endPosition.row + 1,
            signature: signatureOf(text, d),
            exported: javaHasModifier(m, 'public'),
            container: outer,
          });
        }
      } else if (JAVA_TYPE_KIND[m.type]) {
        visitClass(m, outer);
      }
    }
  };

  walk(tree.rootNode, (n) => {
    if (JAVA_TYPE_KIND[n.type]) {
      visitClass(n);
      return false; // 不重复下钻
    }
    if (n.type === 'import_declaration') {
      const p = importPathNode(n);
      if (p) {
        symbols.push({
          name: p.text.split('.').pop() ?? p.text, kind: 'import',
          startLine: lineOf(n), endLine: n.endPosition.row + 1,
          signature: p.text.slice(0, 160), exported: false,
        });
      }
      return false;
    }
    if (n.type === 'package_declaration') return false;
    return undefined;
  });
  return symbols;
}

function cSymbols(text: string, tree: Tree): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const push = (name: string, kind: string, node: TNode, exported = false) => {
    symbols.push({
      name, kind,
      startLine: lineOf(node), endLine: node.endPosition.row + 1,
      signature: signatureOf(text, node), exported,
    });
  };
  walk(tree.rootNode, (n) => {
    if (n.type === 'function_definition') {
      const name = declaratorName(n);
      if (name) push(name, 'function', n);
      return false;
    }
    if (n.type === 'declaration') {
      const name = declaratorName(n);
      if (name) {
        if (hasFunctionDeclarator(n)) push(name, 'function', n);
        else push(name, 'variable', n);
      }
      return false;
    }
    if (n.type === 'struct_specifier' || n.type === 'union_specifier') {
      const name = n.childForFieldName('name')?.text;
      if (name) push(name, n.type === 'struct_specifier' ? 'struct' : 'union', n);
      return false;
    }
    if (n.type === 'enum_specifier') {
      const name = n.childForFieldName('name')?.text;
      if (name) push(name, 'enum', n);
      return false;
    }
    if (n.type === 'type_definition') {
      const name = n.childForFieldName('declarator')?.text ?? declaratorName(n);
      if (name) push(name, 'type', n);
      return false;
    }
    if (n.type === 'preproc_def' || n.type === 'preproc_function_def') {
      const name = n.childForFieldName('name')?.text;
      if (name) push(name, 'macro', n);
      return false;
    }
    if (n.type === 'preproc_include') return false;
    return undefined;
  });
  return symbols;
}

/** 列出文件中所有顶层符号（与 ts-graph.listSymbols 同签名） */
export async function listSymbols(_rootDir: string, filePath: string): Promise<{ symbols: SymbolInfo[]; file: string }> {
  const parsed = await parseFile(filePath);
  if (!parsed) throw new Error(`不支持的代码文件类型: ${filePath}`);
  const { tree, text } = parsed;
  const lang = langForFile(filePath);
  const symbols = lang === 'java' ? javaSymbols(text, tree) : cSymbols(text, tree);
  return { symbols, file: filePath };
}

// ─── read_symbol ─────────────────────────────────────────────

/** 在单文件语法树中查找符号声明节点；支持 ClassName.method */
async function findDeclNode(filePath: string, symbolName: string): Promise<{ node: TNode; container?: string } | null> {
  const parsed = await parseFile(filePath);
  if (!parsed) return null;
  const { tree } = parsed;
  const lang = langForFile(filePath);

  let target = symbolName;
  let container: string | undefined;
  const dot = symbolName.lastIndexOf('.');
  if (dot !== -1) {
    container = symbolName.slice(0, dot);
    target = symbolName.slice(dot + 1);
  }

  if (lang === 'java') {
    let topMatch: TNode | null = null;
    let memberMatch: TNode | null = null;
    let memberContainer: string | undefined;
    const visitClass = (node: TNode, enclosing?: string) => {
      const name = node.childForFieldName('name')?.text;
      const outer = enclosing ? `${enclosing}.${name}` : name;
      if (name === target && !container) topMatch = topMatch ?? node;
      const body = node.childForFieldName('body');
      if (!body) return;
      for (const m of kids(body)) {
        if (m.type === 'method_declaration' || m.type === 'constructor_declaration') {
          const mName = m.childForFieldName('name')?.text;
          if (mName === target) {
            if (container) {
              if (outer === container) { memberMatch = m; memberContainer = outer; return; }
            } else if (!memberMatch) { memberMatch = m; memberContainer = outer; }
          }
        } else if (m.type === 'field_declaration') {
          for (const d of kids(m)) {
            if (d.type !== 'variable_declarator') continue;
            const vName = d.childForFieldName('name')?.text;
            if (vName === target) {
              if (container) {
                if (outer === container) { memberMatch = d; memberContainer = outer; return; }
              } else if (!memberMatch) { memberMatch = d; memberContainer = outer; }
            }
          }
        } else if (JAVA_TYPE_KIND[m.type]) {
          visitClass(m, outer);
        }
      }
    };
    walk(tree.rootNode, (n) => {
      if (JAVA_TYPE_KIND[n.type]) {
        visitClass(n);
        return false;
      }
      if (n.type === 'import_declaration') {
        const p = importPathNode(n);
        if (p && (p.text === target || p.text.endsWith('.' + target))) {
          topMatch = topMatch ?? n;
        }
        return false;
      }
      return undefined;
    });
    // 无容器时局部变量也兜底
    if (!topMatch && !memberMatch) {
      walk(tree.rootNode, (n) => {
        if (n.type === 'variable_declarator') {
          const vName = n.childForFieldName('name')?.text;
          if (vName === target && !memberMatch) memberMatch = n;
        }
        return undefined;
      });
    }
    if (topMatch) return { node: topMatch };
    if (memberMatch) return { node: memberMatch, container: memberContainer };
    return null;
  }

  // C / C++
  let best: TNode | null = null;
  walk(tree.rootNode, (n) => {
    if (n.type === 'function_definition' || n.type === 'declaration') {
      const name = declaratorName(n);
      if (name === target) {
        // 定义优先于原型
        if (!best || (n.type === 'function_definition' && best.type !== 'function_definition')) best = n;
      }
      return false;
    }
    if (n.type === 'struct_specifier' || n.type === 'union_specifier' || n.type === 'enum_specifier' || n.type === 'type_definition') {
      if (n.childForFieldName('name')?.text === target && !best) best = n;
      return false;
    }
    if (n.type === 'preproc_def' || n.type === 'preproc_function_def') {
      if (n.childForFieldName('name')?.text === target && !best) best = n;
      return false;
    }
    if (n.type === 'preproc_include') return false;
    return undefined;
  });
  return best ? { node: best } : null;
}

/** 读取符号完整定义（与 ts-graph.readSymbol 同签名，输出格式对齐） */
export async function readSymbol(rootDir: string, filePath: string, symbolName: string): Promise<string> {
  const abs = resolveAbs(rootDir, filePath);
  const parsed = await parseFile(abs);
  if (!parsed) throw new Error(`不支持的代码文件类型: ${filePath}`);
  const found = await findDeclNode(abs, symbolName);
  if (!found) throw new Error(`未找到符号 "${symbolName}"（文件 ${filePath}）`);

  const { text } = parsed;
  const node = found.node;
  const start = node.startIndex;
  const end = node.endIndex;
  const body = text.slice(start, end);
  const bodyLines = body.split('\n');
  const MAX_BODY = 200;
  let bodyOut = body;
  if (bodyLines.length > MAX_BODY) {
    bodyOut = bodyLines.slice(0, MAX_BODY).join('\n') + `\n... (已截断，共 ${bodyLines.length} 行)`;
  }
  const sig = text.slice(start, Math.min(start + 200, end)).replace(/\s+/g, ' ').trim();
  const targetName = symbolName.split('.').pop() ?? symbolName;
  const container = found.container ? `（容器: ${found.container}）` : '';
  return [
    `── ${targetName} 定义 ──`,
    `文件: ${filePath}`,
    `位置: 第 ${lineOf(node)} - ${node.endPosition.row + 1} 行${container}`,
    `\n签名: ${sig}`,
    `\n代码体 (${bodyLines.length} 行):\n${bodyOut}`,
  ].join('\n');
}

// ─── 引用查找 ────────────────────────────────────────────────

export interface RefLocation {
  file: string;
  line: number;
  column: number;
  context: string;
}

/** 该 identifier 节点是否是声明名（而非引用） */
function isDeclName(node: TNode): boolean {
  const p = node.parent;
  if (!p) return false;
  // Java：childForFieldName('name') 指向该节点（方法/类/字段/参数/局部变量）
  if (p.childForFieldName?.('name')?.id === node.id) {
    // 排除调用点（method_invocation 的 name 也是 field name）
    if (p.type === 'method_invocation' || p.type === 'object_creation_expression') return false;
    return true;
  }
  // C：declarator 链中的名字（函数名/变量名）
  if (p.type.endsWith('_declarator') || p.type === 'init_declarator') return true;
  // 参数声明
  if (p.type === 'parameter_declaration' || p.type === 'formal_parameter') {
    if (p.childForFieldName?.('declarator')?.id === node.id || p.childForFieldName?.('name')?.id === node.id) return true;
  }
  return false;
}

function inImportOrPackage(node: TNode): boolean {
  let n = node.parent;
  while (n) {
    if (n.type === 'import_declaration' || n.type === 'package_declaration' || n.type === 'preproc_include') return true;
    n = n.parent;
  }
  return false;
}

/** 查找符号引用（跨文件，语法级名称匹配；与 ts-graph.findReferences 同签名） */
export async function findReferences(rootDir: string, symbolName: string, targetFile?: string): Promise<{ refs: RefLocation[]; total: number }> {
  const root = path.resolve(rootDir);
  const langs: LangId[] = targetFile
    ? (langForFile(targetFile) ? [langForFile(targetFile)!] : [])
    : presentLangs(root);

  const refs: RefLocation[] = [];
  const seen = new Set<string>();

  for (const lang of langs) {
    const files = collectLangFiles(root, lang);
    const parsedList = await Promise.all(files.map((f) => parseFile(f)));
    for (let i = 0; i < files.length; i++) {
      const parsed = parsedList[i];
      if (!parsed) continue;
      const { tree, text } = parsed;
      const file = files[i];
      walk(tree.rootNode, (n) => {
        if ((n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier') && n.text === symbolName) {
          if (isDeclName(n) || inImportOrPackage(n)) return;
          const line = lineOf(n);
          const col = colOf(n);
          const key = `${file}:${line}:${col}`;
          if (!seen.has(key)) {
            seen.add(key);
            refs.push({ file, line, column: col, context: lineTextOf(text, line) });
          }
        }
        return undefined;
      });
    }
  }

  return { refs: refs.slice(0, 100), total: refs.length };
}

// ─── 调用追踪 ────────────────────────────────────────────────

interface CallSite { name: string; node: TNode; }

function extractCallsJava(body: TNode): CallSite[] {
  const out: CallSite[] = [];
  walk(body, (n) => {
    if (n.type === 'method_invocation') {
      const name = n.childForFieldName('name')?.text;
      if (name) out.push({ name, node: n });
    } else if (n.type === 'object_creation_expression') {
      const t = n.childForFieldName('type')?.text;
      const name = t ? t.split('.').pop()! : null;
      if (name) out.push({ name, node: n });
    }
    return undefined;
  });
  return out;
}

function extractCallsC(body: TNode): CallSite[] {
  const out: CallSite[] = [];
  walk(body, (n) => {
    if (n.type !== 'call_expression') return undefined;
    const fn = n.childForFieldName('function');
    if (!fn) return undefined;
    if (fn.type === 'identifier' || fn.type === 'field_identifier') {
      out.push({ name: fn.text, node: n });
    } else if (fn.type === 'field_expression') {
      const f = fn.childForFieldName('field');
      if (f) out.push({ name: f.text, node: n });
    }
    return undefined;
  });
  return out;
}

/** 在单文件中找目标函数体（Java 方法 / C 函数定义） */
async function findFuncBody(filePath: string, functionName: string): Promise<TNode | null> {
  const parsed = await parseFile(filePath);
  if (!parsed) return null;
  const { tree } = parsed;
  const lang = langForFile(filePath);
  let target = functionName;
  let container: string | undefined;
  const dot = functionName.lastIndexOf('.');
  if (dot !== -1) {
    container = functionName.slice(0, dot);
    target = functionName.slice(dot + 1);
  }
  let found: TNode | null = null;

  if (lang === 'java') {
    const visitClass = (node: TNode, enclosing?: string) => {
      if (found) return;
      const name = node.childForFieldName('name')?.text;
      const outer = enclosing ? `${enclosing}.${name}` : name;
      const body = node.childForFieldName('body');
      if (!body) return;
      for (const m of kids(body)) {
        if (m.type !== 'method_declaration' && m.type !== 'constructor_declaration') continue;
        const mName = m.childForFieldName('name')?.text;
        if (mName === target && (!container || outer === container)) {
          found = m;
          return;
        }
      }
      for (const m of kids(body)) {
        if (JAVA_TYPE_KIND[m.type]) visitClass(m, outer);
      }
    };
    walk(tree.rootNode, (n) => {
      if (found) return false;
      if (JAVA_TYPE_KIND[n.type]) {
        visitClass(n);
        return false;
      }
      return undefined;
    });
    return found;
  }

  // C
  walk(tree.rootNode, (n) => {
    if (found) return false;
    if (n.type === 'function_definition' && declaratorName(n) === target) {
      found = n;
      return false;
    }
    return undefined;
  });
  return found;
}

/** 反向调用链：谁调用了该函数（与 ts-graph.traceCallers 同签名） */
export async function traceCallers(rootDir: string, filePath: string, functionName: string): Promise<{
  callers: { file: string; line: number; callerName: string; context: string }[];
  total: number;
}> {
  const abs = resolveAbs(rootDir, filePath);
  const lang = langForFile(abs);
  if (!lang) throw new Error(`不支持的代码文件类型: ${filePath}`);
  const body = await findFuncBody(abs, functionName);
  if (!body) throw new Error(`未找到函数 "${functionName}" 的声明`);

  const root = path.resolve(rootDir);
  const files = collectLangFiles(root, lang);
  const parsedList = await Promise.all(files.map((f) => parseFile(f)));
  const callers: { file: string; line: number; callerName: string; context: string }[] = [];
  const seen = new Set<string>();
  const targetShort = functionName.split('.').pop();

  for (let i = 0; i < files.length; i++) {
    const parsed = parsedList[i];
    if (!parsed) continue;
    const { tree, text } = parsed;
    const file = files[i];
    const isTarget = path.resolve(file) === abs;
    const onCall = (n: TNode) => {
      if (isTarget && n.startIndex >= body.startIndex && n.endIndex <= body.endIndex) return; // 跳过函数体内自身调用
      const name = lang === 'java'
        ? (n.childForFieldName('name')?.text ?? n.childForFieldName('type')?.text?.split('.').pop())
        : (n.childForFieldName('function')?.type === 'field_expression'
            ? n.childForFieldName('function')?.childForFieldName('field')?.text
            : n.childForFieldName('function')?.text);
      if (!name || name !== targetShort) return;
      const line = lineOf(n);
      const key = `${file}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      callers.push({
        file,
        line,
        callerName: enclosingFunction(n, lang),
        context: lineTextOf(text, line),
      });
    };
    if (lang === 'java') {
      walk(tree.rootNode, (n) => {
        if (n.type === 'method_invocation') onCall(n);
        else if (n.type === 'object_creation_expression') onCall(n);
        return undefined;
      });
    } else {
      walk(tree.rootNode, (n) => {
        if (n.type === 'call_expression') onCall(n);
        return undefined;
      });
    }
  }

  return { callers: callers.slice(0, 100), total: callers.length };
}

/** 正向调用链：该函数调用了谁（与 ts-graph.traceCallees 同签名） */
export async function traceCallees(rootDir: string, filePath: string, functionName: string): Promise<{
  callees: { name: string; file: string; line: number; context: string }[];
  total: number;
}> {
  const abs = resolveAbs(rootDir, filePath);
  const lang = langForFile(abs);
  if (!lang) throw new Error(`不支持的代码文件类型: ${filePath}`);
  const body = await findFuncBody(abs, functionName);
  if (!body) throw new Error(`未找到函数 "${functionName}" 的声明`);

  const { text } = (await parseFile(abs))!;
  const calls = lang === 'java' ? extractCallsJava(body) : extractCallsC(body);
  const seen = new Set<string>();
  const unique = calls.filter((c) => {
    const key = `${c.name}:${lineOf(c.node)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    callees: unique.map((c) => ({ name: c.name, file: filePath, line: lineOf(c.node), context: lineTextOf(text, lineOf(c.node)) })),
    total: unique.length,
  };
}

/** 完整调用链（BFS；与 ts-graph.traceChain 同签名） */
export async function traceChain(rootDir: string, filePath: string, functionName: string, depth = 3): Promise<{
  chain: { name: string; file: string; line: number; depth: number }[];
  truncated: boolean;
}> {
  const abs = resolveAbs(rootDir, filePath);
  const lang = langForFile(abs);
  if (!lang) throw new Error(`不支持的代码文件类型: ${filePath}`);

  const chain: { name: string; file: string; line: number; depth: number }[] = [];
  const visited = new Set<string>();
  let truncated = false;

  const queue: { name: string; file: string; depth: number }[] = [
    { name: functionName, file: abs, depth: 0 },
  ];
  visited.add(`${abs}:${functionName}`);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= depth) {
      truncated = true;
      continue;
    }
    chain.push({ name: cur.name, file: cur.file, line: 0, depth: cur.depth });
    const body = await findFuncBody(cur.file, cur.name);
    if (!body) continue;
    const calls = lang === 'java' ? extractCallsJava(body) : extractCallsC(body);
    const names = new Set(calls.map((c) => c.name));
    for (const callee of names) {
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
  external: boolean;
}

/** Java 包名 → 项目内路径（a.b.C → a/b/C.java），找不到返回 null */
function javaPkgToPath(root: string, pkg: string): string | null {
  let name = pkg;
  if (name.endsWith('.*')) name = name.slice(0, -2);
  // 去掉方法/字段段：逐步回溯到最后一个存在的 .java 文件
  const parts = name.split('.');
  for (let i = parts.length; i >= 1; i--) {
    const rel = parts.slice(0, i).join('/') + '.java';
    if (fs.existsSync(path.join(root, rel))) return rel;
  }
  return null;
}

/** C include 名 → 项目内路径（"sub/util.h" → sub/util.h），找不到返回 null */
function cIncludeToPath(root: string, fromFile: string, inc: string): string | null {
  const clean = inc.replace(/^[<"]|[>"]$/g, '');
  const candidates = [
    path.join(path.dirname(fromFile), clean),
    path.join(root, clean),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.relative(root, c).replace(/\\/g, '/');
  }
  return null;
}

/** 文件依赖分析（与 ts-graph.fileDeps 同签名） */
export async function fileDeps(rootDir: string, filePath: string): Promise<{ deps: DepEdge[]; file: string }> {
  const abs = resolveAbs(rootDir, filePath);
  const root = path.resolve(rootDir);
  const parsed = await parseFile(abs);
  if (!parsed) throw new Error(`不支持的代码文件类型: ${filePath}`);
  const { tree } = parsed;
  const lang = langForFile(abs);
  const deps: DepEdge[] = [];

  if (lang === 'java') {
    walk(tree.rootNode, (n) => {
      if (n.type !== 'import_declaration') return undefined;
      const p = importPathNode(n);
      if (!p) return undefined;
      const spec = p.text;
      const resolved = javaPkgToPath(root, spec);
      deps.push({
        from: filePath,
        to: resolved ?? spec,
        kind: 'import',
        line: lineOf(n),
        external: resolved === null,
      });
      return undefined;
    });
  } else {
    walk(tree.rootNode, (n) => {
      if (n.type !== 'preproc_include') return undefined;
      const p = importPathNode(n);
      if (!p) return undefined;
      const spec = p.text;
      const isSystem = p.type === 'system_lib_string';
      const resolved = isSystem ? null : cIncludeToPath(root, abs, spec);
      deps.push({
        from: filePath,
        to: resolved ?? spec,
        kind: 'import',
        line: lineOf(n),
        external: resolved === null,
      });
      return undefined;
    });
  }

  return { deps, file: filePath };
}

// ─── 影响面分析 ──────────────────────────────────────────────

export interface RadiusHit {
  file: string;
  line: number;
  kind: 'import' | 'reference' | 'direct';
  context: string;
}

/** 影响面分析（与 ts-graph.blastRadius 同签名） */
export async function blastRadius(rootDir: string, filePath: string, symbolName?: string): Promise<{
  hits: RadiusHit[];
  files: string[];
  total: number;
}> {
  const abs = resolveAbs(rootDir, filePath);
  const root = path.resolve(rootDir);
  const lang = langForFile(abs);
  if (!lang) throw new Error(`不支持的代码文件类型: ${filePath}`);

  const relFrom = path.relative(root, abs).replace(/\\/g, '/');
  const hits: RadiusHit[] = [];
  const seen = new Set<string>();
  const files = collectLangFiles(root, lang);
  const parsedList = await Promise.all(files.map((f) => parseFile(f)));

  // 1. 反向依赖：谁 import/include 了这个文件
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (path.resolve(f) === abs) continue;
    const parsed = parsedList[i];
    if (!parsed) continue;
    const { tree, text } = parsed;
    const isDep = (n: TNode): boolean => {
      const p = importPathNode(n);
      if (!p) return false;
      const spec = p.text;
      if (lang === 'java') {
        // 目标 a/b/C.java → 包名 a.b.C；import 以该包名开头即命中
        const targetPkg = relFrom.replace(/\.java$/, '').replace(/\//g, '.');
        return spec === targetPkg || spec.startsWith(targetPkg + '.') || spec.startsWith(targetPkg + '.*');
      }
      const clean = spec.replace(/^[<"]|[>"]$/g, '');
      return clean === relFrom || clean.endsWith('/' + relFrom) || relFrom.endsWith('/' + clean) || clean.split('/').pop() === relFrom.split('/').pop();
    };
    const addHit = (n: TNode) => {
      const line = lineOf(n);
      const key = `${f}:${line}:import`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ file: f, line, kind: 'import', context: lineTextOf(text, line) });
    };
    if (lang === 'java') {
      walk(tree.rootNode, (n) => {
        if (n.type === 'import_declaration' && isDep(n)) addHit(n);
        return undefined;
      });
    } else {
      walk(tree.rootNode, (n) => {
        if (n.type === 'preproc_include' && isDep(n)) addHit(n);
        return undefined;
      });
    }
  }

  // 2. 指定符号时：谁引用了该符号（跨文件，跳过本文件）
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

  const hitFiles = [...new Set(hits.map((h) => h.file))];
  return { hits: hits.slice(0, 100), files: hitFiles, total: hits.length };
}

// ─── 路径辅助 ────────────────────────────────────────────────

function resolveAbs(rootDir: string, rawPath: string): string {
  const p = path.isAbsolute(rawPath) ? rawPath : path.join(rootDir, rawPath);
  return path.resolve(p);
}





