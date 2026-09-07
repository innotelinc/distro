// Origin-mode indicator for the Distro shell.
//
// The full shell (live preview + terminal) only runs on a trustworthy origin
// (HTTPS or localhost); plain HTTP from a LAN IP/hostname is chat-only. This
// chip shows which mode you're in and, when you're on a chat-only origin,
// offers a one-click link to the public HTTPS host (VITE_PUBLIC_ORIGIN, or
// the same hostname over HTTPS when it's not a bare IP).
import { useEffect, useState } from 'react';
import { httpsOriginHint, pageOriginMode } from '~/lib/control-plane';

type Mode = 'unknown' | 'local' | 'https' | 'insecure';

export function OriginBadge() {
  const [mode, setMode] = useState<Mode>('unknown');
  const [httpsUrl, setHttpsUrl] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setMode(pageOriginMode());
    setHttpsUrl(httpsOriginHint());
  }, []);

  if (mode === 'unknown') return null;

  const labels: Record<Exclude<Mode, 'unknown'>, { text: string; color: string; title: string }> = {
    local: { text: 'localhost · full shell', color: '#34d399', title: 'Localhost is a trustworthy origin — live preview and terminal work here.' },
    https: { text: 'HTTPS · full shell', color: '#34d399', title: 'Secure origin — live preview and terminal work here.' },
    insecure: {
      text: 'Plain HTTP · chat only',
      color: '#f59e0b',
      title: 'Plain HTTP from an IP/hostname is not a trustworthy origin, so the browser blocks WebContainer — chat works, but live preview and terminal cannot connect.',
    },
  };
  const info = labels[mode];

  const chip = (
    <span
      title={info?.title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        fontWeight: 500,
        padding: '4px 10px',
        borderRadius: '999px',
        border: '1px solid var(--bolt-elements-borderColor)',
        background: 'var(--bolt-elements-background-depth-2)',
        color: 'var(--bolt-elements-textSecondary)',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: info?.color, display: 'inline-block' }} />
      {info?.text}
    </span>
  );

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
      {chip}
      {mode === 'insecure' && httpsUrl && (
        <a
          href={httpsUrl}
          target="_blank"
          rel="noreferrer"
          title={`Open ${httpsUrl} to use the full shell (live preview + terminal)`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '12px',
            fontWeight: 600,
            padding: '4px 10px',
            borderRadius: '999px',
            color: '#fff',
            background: 'linear-gradient(135deg, #06b6d4, #6366f1)',
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Open HTTPS host ↗
        </a>
      )}
    </span>
  );
}
