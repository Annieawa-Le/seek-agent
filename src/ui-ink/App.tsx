import React, { useMemo, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { TerminalUI } from './TerminalUI';
import type { UIState } from './types';
import { buildBlocks, flattenBlocks, type StyledLine } from './format';
import { truncate, visibleWidth } from './utils';

/** 固定占位行数：header 3 + 状态栏 1 + 输入栏 1 */
const FIXED_ROWS = 5;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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

function Header({ state }: { state: UIState }) {
  const ctxText = state.contextChars > 0
    ? (state.contextTokens > 0
        ? `ctx: ${state.contextTokens}t / max: ${state.maxContextChars >= 10000 ? (state.maxContextChars / 1000).toFixed(1) + 'k' : state.maxContextChars}ch`
        : `ctx: ${state.contextChars >= 10000 ? (state.contextChars / 1000).toFixed(1) + 'k' : state.contextChars}ch / max: ${state.maxContextChars >= 10000 ? (state.maxContextChars / 1000).toFixed(1) + 'k' : state.maxContextChars}ch`)
    : 'ctx: --';
  const toolsText = state.toolCallCount > 0 ? `⚙ ${state.toolCallCount}` : '';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">╭</Text>
        <Text color="cyan">{'─'.repeat(52)}</Text>
        <Text color="cyan">╮</Text>
      </Box>
      <Box>
        <Text color="cyan">│ </Text>
        <Text bold color="white">✨ Seek Agent</Text>
        <Text color="gray" dimColor>  {truncate(ctxText, 36)}</Text>
        {toolsText && <Text color="magenta" dimColor>  {toolsText}</Text>}
        <Text color="cyan">{' '.repeat(Math.max(1, 44 - visibleWidth(ctxText) - (toolsText ? visibleWidth(toolsText) + 2 : 0)))}│</Text>
      </Box>
      <Box>
        <Text color="cyan">╰</Text>
        <Text color="cyan">{'─'.repeat(52)}</Text>
        <Text color="cyan">╯</Text>
      </Box>
    </Box>
  );
}

function StatusBar({ state }: { state: UIState }) {
  const spinner = SPINNER_FRAMES[state.spinnerIndex % SPINNER_FRAMES.length];
  let status = '';
  let color = 'gray';
  if (state.listenName) {
    status = `${spinner} 审查中: ${state.listenName}`;
    color = 'magenta';
  } else if (state.isProcessing) {
    status = `${spinner} AI 处理中…`;
    color = 'cyan';
  } else if (state.thinkingActive) {
    status = `${spinner} 思考中…`;
    color = 'yellow';
  } else {
    status = '就绪';
  }
  const scrollHint = state.scrollOffset > 0 ? ` ↑${state.scrollOffset} 条更早消息` : '';

  return (
    <Box>
      <Text color={color}>{status}</Text>
      {scrollHint && <Text color="yellow" dimColor>{scrollHint}</Text>}
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

/** 输入栏：prompt + 输入文本 + 光标 */
function InputBar({ state }: { state: UIState }) {
  const { input, cursorPos } = state;
  const before = input.slice(0, cursorPos);
  const at = input[cursorPos] ?? ' ';
  const after = input.slice(cursorPos + 1);
  const placeholder = input.length === 0 ? '输入消息，/help 查看指令…' : '';

  return (
    <Box>
      <Text color="green">{state.promptText}</Text>
      {placeholder ? (
        <Text color="gray" dimColor>{placeholder}</Text>
      ) : (
        <>
          <Text>{before}</Text>
          <Text inverse backgroundColor="cyan" color="black">{at}</Text>
          <Text>{after}</Text>
        </>
      )}
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
    <Box flexDirection="column">
      <Header state={state} />
      <MessageArea state={state} width={columns} height={msgHeight} />
      <StatusBar state={state} />
      <InputBar state={state} />
    </Box>
  );
}

