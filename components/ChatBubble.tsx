
import React from 'react';
import type { Message } from '../types';
import { Sender } from '../types';

interface ChatBubbleProps {
  message: Message;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({ message }) => {
  const isUser = message.sender === Sender.User;

  const bubbleClasses = isUser
    ? 'bg-cyan-800/50 self-end'
    : 'bg-gray-700/50 self-start';

  const textClasses = isUser ? 'text-cyan-300' : 'text-gray-200';
  
  const finalityStyle = message.isFinal === false ? 'opacity-70' : 'opacity-100';

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-xs md:max-w-md lg:max-w-2xl rounded-lg p-3 shadow-lg ${bubbleClasses} ${finalityStyle}`}
      >
        <p className={`text-sm whitespace-pre-wrap ${textClasses}`}>{message.text}</p>
      </div>
    </div>
  );
};
