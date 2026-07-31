import { memo, useEffect, useRef } from 'react';
import type { DisplayMessage } from '@/hooks/useMessages.ts';
import { MessageItem } from './MessageItem.tsx';

interface Props {
  messages: DisplayMessage[];
}

export const MessageList = memo(function MessageList({ messages }: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  // 只跟踪"末尾消息"，中间消息更新（如工具结果回填）不触发滚动
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const messageCount = messages.length;

  useEffect(() => {
    if (userScrolledUpRef.current) return;
    areaRef.current?.scrollTo({ top: areaRef.current.scrollHeight, behavior: 'smooth' });
  }, [lastMsg, messageCount]);

  const handleScroll = () => {
    const el = areaRef.current;
    if (!el) return;
    const threshold = 100;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    userScrolledUpRef.current = !atBottom;
  };

  return (
    <div id="message-area" ref={areaRef} onScroll={handleScroll}>
      <div id="message-list">
        {messages.map(msg => (
          <MessageItem key={msg.id} msg={msg} />
        ))}
      </div>
    </div>
  );
});

