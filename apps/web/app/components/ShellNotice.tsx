// Distro shell notice.
//
// The live preview and terminal run on WebContainer, an in-browser Node
// runtime that requires a *trustworthy* origin: browsers only honor the
// COOP/COEP headers that enable cross-origin isolation (and only register
// service workers) on HTTPS or on http://localhost / http://127.0.0.1.
//
// When the app is opened over plain HTTP from a LAN IP or hostname the shell
// still chats fine, but WebContainer cannot boot, so the terminal and live
// preview stay disconnected. Rather than letting that look like a broken
// shell, explain it and point at the fix (HTTPS via the reverse proxy, or
// localhost).
import { useEffect, useState } from 'react';

type ShellState = 'unknown' | 'ok' | 'blocked';

export function ShellNotice() {
  const [state, setState] = useState<ShellState>('unknown');

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const secure = window.isSecureContext === true;
    const isolated = window.crossOriginIsolated === true;

    setState(secure && isolated ? 'ok' : 'blocked');
  }, []);

  if (state === 'unknown' || state === 'ok') {
    return null;
  }

  return (
    <div
      className="flex items-start gap-2 px-4 py-2 text-[13px] leading-snug"
      style={{
        background: 'var(--bolt-elements-background-depth-2)',
        borderBottom: '1px solid rgba(251, 191, 36, 0.45)',
        color: 'var(--bolt-elements-textSecondary)',
      }}
    >
      <span style={{ color: '#f59e0b' }} aria-hidden="true">
        ⚠
      </span>
      <div>
        <strong style={{ color: 'var(--bolt-elements-textPrimary)' }}>Live preview &amp; terminal are disabled here.</strong>{' '}
        WebContainer (the in-browser runtime behind them) only runs on a secure origin — HTTPS or{' '}
        <code>http://localhost:5173</code>. You're connected over plain HTTP from an IP or hostname, so the browser
        blocks it. Chat still works. Open the app via your HTTPS reverse-proxy hostname (e.g. nginx proxy manager) or
        localhost to use the full shell.
      </div>
    </div>
  );
}
