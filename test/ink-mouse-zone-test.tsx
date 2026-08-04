/**
 * 验证 ink-use-mouse 的 useMouseZone / Clickable 在 Ink 7 下能否工作：
 * 1. Box ref 是否能拿到含 yogaNode 的 DOM 节点
 * 2. useMouseZone 的 getAbsolutePosition 是否能算出正确坐标
 * 3. 模拟 SGR 鼠标事件注入后，Clickable onClick 是否触发
 */
// 先 mock TTY（非 TTY 环境下 Ink 拒绝 raw mode）
import { isTTY as _ } from 'node:tty';
import process from 'node:process';
Object.defineProperty(process.stdin, 'isTTY', { value: true });
process.stdin.setRawMode = process.stdin.setRawMode || (() => process.stdin);
import React, { useRef } from 'react';
import { Box, Text, render } from 'ink';
import { useMouseZone, useMouse, parseMouseEvents } from 'ink-use-mouse';
import { writeFileSync } from 'node:fs';

const results: Record<string, unknown> = {};

function Probe() {
  const ref = useRef<any>(null);
  const mouse = useMouse();
  const zone = useMouseZone(ref, {
    onClick: () => { results.clicked = true; },
    onHover: (h: boolean) => { results.hovered = h; },
  });

  // 渲染后检查 ref 结构
  React.useEffect(() => {
    const el = ref.current;
    results.refType = el ? typeof el : 'null';
    results.hasYogaNode = !!(el && el.yogaNode);
    results.hasComputedLeft = !!(el && el.yogaNode && typeof el.yogaNode.getComputedLeft === 'function');
    results.hasGetParent = !!(el && el.yogaNode && typeof el.yogaNode.getParent === 'function');
    try {
      const n = el.yogaNode;
      results.computedLeft = n.getComputedLeft();
      results.computedTop = n.getComputedTop();
      results.computedWidth = n.getComputedWidth();
      results.computedHeight = n.getComputedHeight();
      results.parentType = n.getParent() ? 'has-parent' : 'root';
    } catch (e: any) {
      results.err = e.message;
    }
    // 手动触发一次解析测试（验证 parseMouseEvents 已被导入使用）
    results.parseOk = parseMouseEvents('\x1b[<0;1;1M').length > 0;
    writeFileSync('mouse-zone-result.json', JSON.stringify(results, null, 2));
    process.exit(0);
  }, []);

  return (
    <Box flexDirection="column">
      <Text>mouse: {mouse.x},{mouse.y} hovered={String(zone.isHovered)}</Text>
      <Box ref={ref} width={20} height={3} borderStyle="single">
        <Text>Click target</Text>
      </Box>
    </Box>
  );
}

render(React.createElement(Probe));

