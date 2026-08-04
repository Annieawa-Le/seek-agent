import React, { useMemo, useRef, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useMouse, Clickable } from 'ink-use-mouse';
import type { TerminalUI } from './TerminalUI';
import type { UIState } from './types';
import { buildBlocks, flattenBlocks, type StyledLine } from './format';
import { truncate } from './utils';
import { filterPalette, type PaletteItem } from './palette';

/** 固定占位行数：header 1 + 输入栏 2 + 状态栏 1 */
const FIXED_ROWS = 4;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 命令面板最大可见行数（超出滚动） */
const PALETTE_MAX_ROWS = 12;
/** 面板宽度 */
const PALETTE_WIDTH = 54;

interface AppProps {
  ui: TerminalUI;
}

/** 单行渲染：根据样式信息输出 Text */
function StyledText({ line }: { line: StyledLine }) {
  return (
    <Text color={line.color} dimColor={line.dim} bold={line.bold}>
      {line.text}
    </Text>
  );
}

/** 顶部标题栏：应用名 + 分支 + 右侧状态 */
function TitleBar({ state }: { state: UIState }) {
  const branch = state.gitBranch ? `:${state.gitBranch}` : '';
  const ctxText = state.contextChars > 0
    ? `ctx ${state.contextTokens > 0 ? state.contextTokens + 't' : (state.contextChars >= 10000 ? (state.contextChars / 1000).toFixed(1) + 'k' : state.contextChars) + 'ch'}`
    : 'ctx --';
  const toolsText = state.toolCallCount > 0 ? `⚙ ${state.toolCallCount}` : '';
  const right = [ctxText, toolsText].filter(Boolean).join(' · ');

  return (
    <Box justifyContent="space-between">
      <Box>
        <Text color="#7aa2f7">◧</Text>
        <Text bold color="white"> Seek Agent</Text>
        <Text color="gray" dimColor>{branch}</Text>
      </Box>
      <Box>
        {right && <Text color="gray" dimColor>{right}</Text>}
      </Box>
    </Box>
  );
}

/** 底部状态栏：左侧路径，右侧快捷键提示 */
function StatusBar({ state }: { state: UIState }) {
  const spinner = SPINNER_FRAMES[state.spinnerIndex % SPINNER_FRAMES.length];
  let status = '';
  let color: string = 'gray';
  if (state.listenName) {
    status = `${spinner} 审查中: ${state.listenName}`;
    color = '#bb9af7';
  } else if (state.isProcessing) {
    status = `${spinner} AI 处理中…`;
    color = '#7aa2f7';
  } else if (state.thinkingActive) {
    status = `${spinner} 思考中…`;
    color = '#e0af68';
  } else {
    status = '就绪';
  }
  const scrollHint = state.scrollOffset > 0 ? ` ↑${state.scrollOffset} 条更早消息` : '';
  const branch = state.gitBranch ? `:${state.gitBranch}` : '';

  let cwd = '';
  try {
    cwd = process.cwd().split(/[\\/]/).slice(-2).join('/');
  } catch {
    cwd = '';
  }

  return (
    <Box justifyContent="space-between">
      <Box>
        <Text color={color}>{status}</Text>
        {scrollHint && <Text color="#e0af68" dimColor>{scrollHint}</Text>}
      </Box>
      <Box>
        <Text color="gray" dimColor>{truncate(`${cwd}${branch}`, 32)}</Text>
        <Text color="gray" dimColor>{'  '}</Text>
        <Text color="gray" dimColor>tab agents · ctrl+p commands</Text>
      </Box>
    </Box>
  );
}

/** 消息区：把全部消息扁平化为行，按滚动偏移切片渲染 */
function MessageArea({ state, width, height }: { state: UIState; width: number; height: number }) {
  const blocks = useMemo(() => buildBlocks(state, width), [state, width]);
  const flat = useMemo(() => flattenBlocks(blocks), [blocks]);

  // 可见窗口：从底部开始，最多 height 行，跳过 scrollOffset 行
  const visible = useMemo(() => {
    const end = Math.max(0, flat.length - state.scrollOffset);
    const start = Math.max(0, end - height);
    return flat.slice(start, end);
  }, [flat, state.scrollOffset, height]);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visible.map(({ line, msgIndex }, i) => (
        <Box key={`${msgIndex}-${i}`}>
          <StyledText line={line} />
        </Box>
      ))}
    </Box>
  );
}

/** 输入栏：蓝色指示条 + prompt + 输入 + 光标（两行：输入行 + 模型信息行） */
function InputBar({ state }: { state: UIState }) {
  const { input, cursorPos } = state;
  const before = input.slice(0, cursorPos);
  const at = input[cursorPos] ?? ' ';
  const after = input.slice(cursorPos + 1);
  const placeholder = input.length === 0 ? 'Ask anything…' : '';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="#7aa2f7">│</Text>
        <Text color="green">{state.promptText}</Text>
        {placeholder ? (
          <Text color="gray" dimColor>{placeholder}</Text>
        ) : (
          <>
            <Text>{before}</Text>
            <Text inverse backgroundColor="#7aa2f7" color="black">{at}</Text>
            <Text>{after}</Text>
          </>
        )}
      </Box>
      <Box>
        <Text color="gray" dimColor>  Build · DeepSeek V4 Flash Free Seek Agent</Text>
      </Box>
    </Box>
  );
}

/** 命令叠加层：居中悬浮面板，支持搜索、键盘/鼠标选择、滚轮滚动 */
function CommandPalette({ ui, state, width, height }: {
  ui: TerminalUI;
  state: UIState;
  width: number;
  height: number;
}) {
  const items = ui.getPaletteItems();
  const visible = useMemo(() => filterPalette(items, state.paletteQuery), [items, state.paletteQuery]);

  // 鼠标：滚轮滚动选中项、点击执行（面板打开且 TTY 时才激活鼠标上报）
  const mouse = useMouse({ disabled: !state.paletteOpen || process.stdin.isTTY !== true });

  // 面板可见窗口：选中项保持在可见区内
  const { paletteIndex } = state;
  const scrollTop = useMemo(() => {
    if (visible.length <= PALETTE_MAX_ROWS) return 0;
    const maxTop = visible.length - PALETTE_MAX_ROWS;
    return Math.max(0, Math.min(paletteIndex - Math.floor(PALETTE_MAX_ROWS / 2), maxTop));
  }, [paletteIndex, visible.length]);
  const windowItems = visible.slice(scrollTop, scrollTop + PALETTE_MAX_ROWS);

  // 滚轮滚动（叠加层打开时）
  const mouseRef = useRef(mouse);
  mouseRef.current = mouse;
  const prevScrollRef = useRef(mouse.type);
  if (state.paletteOpen) {
    const cur = mouse.type;
    const prev = prevScrollRef.current;
    if (cur !== prev && (cur === 'scroll-up' || cur === 'scroll-down')) {
      prevScrollRef.current = cur;
      // 用 setTimeout 避开渲染期直接改 ui 状态
      queueMicrotask(() => {
        if (cur === 'scroll-up') ui.movePaletteIndex(-1, visible.length);
        else ui.movePaletteIndex(1, visible.length);
      });
    } else {
      prevScrollRef.current = cur;
    }
  }

  // 分组渲染：按 group 排序保持顺序，组间插入分隔标题
  const rows: Array<{ type: 'header'; text: string } | { type: 'item'; item: PaletteItem; index: number }> = [];
  let lastGroup = '';
  windowItems.forEach((item, i) => {
    const globalIndex = scrollTop + i;
    if (item.group !== lastGroup) {
      rows.push({ type: 'header', text: item.group });
      lastGroup = item.group;
    }
    rows.push({ type: 'item', item, index: globalIndex });
  });

  const overlayWidth = Math.min(PALETTE_WIDTH, width - 4);
  const overlayHeight = Math.min(rows.length + 2, PALETTE_MAX_ROWS + 3);
  const left = Math.max(0, Math.floor((width - overlayWidth) / 2));
  const top = Math.max(1, Math.floor((height - overlayHeight) / 2));

  return (
    <Box position="absolute" top={0} left={0} width={width} height={height} flexDirection="column">
      {/* 背景变暗 */}
      <Box position="absolute" top={0} left={0} width={width} height={height} backgroundColor="#000000" />
      {/* 面板 */}
      <Box position="absolute" top={top} left={left} width={overlayWidth} flexDirection="column" borderStyle="round" borderColor="#565f89">
        {/* 标题行 */}
        <Box justifyContent="space-between" paddingX={1}>
          <Text bold color="white">Commands</Text>
          <Text color="gray" dimColor>esc</Text>
        </Box>
        {/* 搜索输入 */}
        <Box marginX={1} marginTop={1}>
          <Text color="#ff9e64" bold>{state.paletteQuery ? state.paletteQuery[0] : ''}</Text>
          <Text color="gray">{state.paletteQuery ? state.paletteQuery.slice(1) : 'Search'}</Text>
        </Box>
        <Box height={1} />
        {/* 列表 */}
        {rows.map((row, i) => {
          if (row.type === 'header') {
            return (
              <Box key={`h-${i}`} paddingX={1}>
                <Text color="#bb9af7" dimColor>{row.text}</Text>
              </Box>
            );
          }
          const selected = row.index === paletteIndex;
          return (
            <Clickable
              key={`i-${row.item.id}`}
              onClick={() => ui.runPaletteItem(row.item)}
            >
              <Box
                paddingX={1}
                backgroundColor={selected ? '#ff9e64' : undefined}
                justifyContent="space-between"
                width={overlayWidth - 2}
              >
                <Text color={selected ? 'black' : 'white'} bold={selected}>
                  {selected ? '› ' : '  '}{row.item.label}
                </Text>
                {row.item.shortcut && (
                  <Text color={selected ? 'black' : 'gray'} dimColor={!selected}>
                    {row.item.shortcut}
                  </Text>
                )}
              </Box>
            </Clickable>
          );
        })}
        {/* 底部提示 */}
        {rows.length === 0 && (
          <Box paddingX={1} paddingY={1}>
            <Text color="gray" dimColor>无匹配命令</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** Ink 根组件 */
export function App({ ui }: AppProps) {
  const version = useSyncExternalStore(ui.subscribe, ui.getSnapshot);
  void version; // 版本号变化触发重渲染
  const { columns, rows } = useWindowSize();

  // 按键处理：转发给 TerminalUI（非 TTY 管道环境不挂 raw mode）
  const isTTY = process.stdin.isTTY === true;
  useInput((input, key) => {
    ui.handleKey(input, key as any);
  }, { isActive: isTTY });

  const state = ui.getState();
  const msgHeight = Math.max(1, rows - FIXED_ROWS);

  return (
    <Box flexDirection="column" height={rows}>
      <TitleBar state={state} />
      <MessageArea state={state} width={columns} height={msgHeight} />
      <InputBar state={state} />
      <StatusBar state={state} />
      {state.paletteOpen && (
        <CommandPalette ui={ui} state={state} width={columns} height={rows} />
      )}
    </Box>
  );
}





