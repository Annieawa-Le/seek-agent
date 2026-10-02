import { memo, useEffect, useRef, useLayoutEffect } from 'react';
import type { DisplayMessage } from '@/hooks/useMessages.ts';
import { MessageItem } from './MessageItem.tsx';

interface Props {
  messages: DisplayMessage[];
  /** 是否还有更早的消息可加载（懒加载会话重放时由 useMessages 提供） */
  hasEarlier?: boolean;
  /** 向上翻阅到顶部时触发：加载更早一批气泡 */
  onLoadEarlier?: () => void;
}

export const MessageList = memo(function MessageList({ messages, hasEarlier, onLoadEarlier }: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  /** prepend 检测：记录首条消息 id，变化说明顶部插入了新批次 */
  const firstIdRef = useRef<number | undefined>(undefined);
  /** 上次渲染后的内容高度，用于补偿 prepend 后的滚动位置 */
  const prevScrollHeightRef = useRef(0);
  /** 节流：同一帧内只触发一次向上加载 */
  const loadingEarlierRef = useRef(false);

  // 只跟踪"末尾消息"，中间消息更新（如工具结果回填）不触发滚动
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const messageCount = messages.length;

  useEffect(() => {
    if (userScrolledUpRef.current) return;
    // 用瞬时定位而非 smooth：避免滚动动画过程 scrollTop 经过顶部而误触发向上加载
    areaRef.current?.scrollTo({ top: areaRef.current.scrollHeight, behavior: 'auto' });
  }, [lastMsg, messageCount]);

  // 顶部插入新批次后，scrollTop 需增加新增内容高度，保持用户阅读位置不跳动
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const firstId = messages[0]?.id;
    if (firstId !== firstIdRef.current && prevScrollHeightRef.current > 0) {
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
    }
    firstIdRef.current = firstId;
    prevScrollHeightRef.current = el.scrollHeight;
  });


  const handleScroll = () => {
    const el = areaRef.current;
    if (!el) return;
    const threshold = 100;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    userScrolledUpRef.current = !atBottom;
    // 接近顶部且还有更早消息：自动加载下一批（loadEarlier 幂等，重复触发无害）
    if (el.scrollTop < 200 && hasEarlier && onLoadEarlier && !loadingEarlierRef.current) {
      loadingEarlierRef.current = true;
      onLoadEarlier();
      requestAnimationFrame(() => { loadingEarlierRef.current = false; });
    }
  };

  return (
    <div id="message-area" className="message-area" ref={areaRef} onScroll={handleScroll}>
      <div id="message-list" className="message-list">
        {messages.map(msg => (
          <MessageItem key={msg.id} msg={msg} />
        ))}
      </div>
    </div>
  );
});
