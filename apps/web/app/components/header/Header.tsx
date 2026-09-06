import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { chatStore } from '~/lib/stores/chat';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';

export function Header() {
  const chat = useStore(chatStore);

  return (
    <header
      className={classNames('flex items-center p-5 border-b h-[var(--header-height)]', {
        'border-transparent': !chat.started,
        'border-bolt-elements-borderColor': chat.started,
      })}
    >
      <div className="flex items-center gap-2 z-logo text-bolt-elements-textPrimary cursor-pointer">
        <div className="i-ph:sidebar-simple-duotone text-xl" />
        <a href="/" title="Distro home" className="text-2xl font-semibold text-accent flex items-center gap-2 select-none">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
            <defs>
              <linearGradient id="distro-mark" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#06b6d4" />
                <stop offset="100%" stopColor="#6366f1" />
              </linearGradient>
            </defs>
            <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#distro-mark)" />
            <g fill="#ffffff">
              <circle cx="16" cy="16" r="3.6" />
              <circle cx="16" cy="6.9" r="2.2" />
              <circle cx="24.5" cy="21" r="2.2" />
              <circle cx="7.5" cy="21" r="2.2" />
            </g>
            <g stroke="#ffffff" strokeWidth="1.4" opacity="0.65">
              <line x1="16" y1="9.4" x2="14.2" y2="13.6" />
              <line x1="16" y1="9.4" x2="17.8" y2="13.6" />
              <line x1="14.2" y1="13.6" x2="9.3" y2="19.6" />
              <line x1="17.8" y1="13.6" x2="22.7" y2="19.6" />
              <line x1="9.3" y1="19.6" x2="7.7" y2="20.2" />
              <line x1="22.7" y1="19.6" x2="24.3" y2="20.2" />
            </g>
          </svg>
          <span>Distro</span>
        </a>
      </div>
      {chat.started && ( // Display ChatDescription and HeaderActionButtons only when the chat has started.
        <>
          <span className="flex-1 px-4 truncate text-center text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ChatDescription />}</ClientOnly>
          </span>
          <ClientOnly>
            {() => (
              <div className="mr-1">
                <HeaderActionButtons />
              </div>
            )}
          </ClientOnly>
        </>
      )}
    </header>
  );
}
