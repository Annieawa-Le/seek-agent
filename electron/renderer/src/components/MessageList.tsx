import { useEffect, useRef } from 'react';
import type { DisplayMessage } from '@/hooks/useMessages.ts';
import { MessageItem } from './MessageItem.tsx';

interface Props {
  messages: DisplayMessage[];
}


export function MessageList({ messages }: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    if (!userScrolledUpRef.current) {
      areaRef.current?.scrollTo({ top: areaRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

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
}



