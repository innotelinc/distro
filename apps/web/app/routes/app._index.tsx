import { json, type MetaFunction } from '@remix-run/cloudflare';
import { useEffect } from 'react';
import { ClientOnly } from 'remix-utils/client-only';
import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { CONTROL_PLANE_ENABLED, getToken } from '~/lib/control-plane';

export const meta: MetaFunction = () => {
  return [
    { title: 'Distro' },
    { name: 'description', content: 'Distro — describe an app and watch an AI agent build, run, and preview it in your browser.' },
  ];
};

export const loader = () => json({});

/**
 * Landing page component for Distro
 * Note: Settings functionality should ONLY be accessed through the sidebar menu.
 * Do not add settings button/panel to this landing page as it was intentionally removed
 * to keep the UI clean and consistent with the design system.
 */
export default function Index() {
  // Distro multi-user mode: require a control-plane session (or explicit
  // host-mode opt-out) before showing the workspace.
  useEffect(() => {
    if (CONTROL_PLANE_ENABLED && !getToken() && !window.localStorage.getItem('distro_host_mode')) {
      window.location.replace('/login');
    }
  }, []);

  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <ClientOnly fallback={<BaseChat />}>{() => <Chat />}</ClientOnly>
    </div>
  );
}
