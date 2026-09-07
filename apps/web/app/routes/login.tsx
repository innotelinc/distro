import { useEffect, useState } from 'react';
import { useNavigate } from '@remix-run/react';
import type { MetaFunction } from '@remix-run/cloudflare';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { controlPlaneBase, CONTROL_PLANE_ENABLED, logIn, signUp, adoptGatewayKey, finishOidcLogin, oidcConfig } from '~/lib/control-plane';

export const meta: MetaFunction = () => {
  return [{ title: 'Sign in — Distro' }];
};

const inputClass =
  'w-full rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-sm text-bolt-elements-textPrimary outline-none focus:border-bolt-elements-focus';

export default function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);

  // Detect Authentik SSO on the control plane; listen for the popup callback.
  useEffect(() => {
    if (!CONTROL_PLANE_ENABLED || typeof window === 'undefined') return;
    oidcConfig()
      .then((c) => setSsoEnabled(c.enabled))
      .catch(() => setSsoEnabled(false));
    const onMessage = async (event: MessageEvent) => {
      if (event.data?.source !== 'distro-oidc' || !event.data.token) return;
      const origin = (() => {
        try {
          return new URL(controlPlaneBase()).origin;
        } catch {
          return '';
        }
      })();
      if (origin && event.origin !== origin) return;
      setSsoBusy(true);
      try {
        await finishOidcLogin(event.data.token, event.data.user || {});
        navigate('/app', { replace: true });
      } catch (err: any) {
        setError(err?.message || 'Authentik sign-in succeeded but the gateway key could not be adopted — sign out and in again.');
        setSsoBusy(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const startOidc = () => {
    const popup = window.open(`${controlPlaneBase()}/api/auth/oidc/start`, '_blank', 'width=520,height=660');
    if (!popup) {
      setError('Pop-up blocked — allow pop-ups for this site to use Authentik sign-in.');
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'signup') {
        await signUp(email, password);
        await logIn(email, password);
      } else {
        await logIn(email, password);
      }
      await adoptGatewayKey(); // per-user gateway key -> apiKeys cookie
      navigate('/app', { replace: true });
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
      setBusy(false);
    }
  };

  return (
    <div className="relative flex flex-col items-center justify-center min-h-full overflow-y-auto bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary px-6">
      <BackgroundRays />
      <div className="w-full max-w-sm">
        <a href="/" className="flex items-center justify-center gap-2 text-2xl font-semibold mb-8 select-none">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
            <defs>
              <linearGradient id="distro-mark-login" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#06b6d4" />
                <stop offset="100%" stopColor="#6366f1" />
              </linearGradient>
            </defs>
            <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#distro-mark-login)" />
            <g fill="#ffffff">
              <circle cx="16" cy="16" r="3.6" />
              <circle cx="16" cy="6.9" r="2.2" />
              <circle cx="24.5" cy="21" r="2.2" />
              <circle cx="7.5" cy="21" r="2.2" />
            </g>
          </svg>
          <span>Distro</span>
        </a>

        <h1 className="text-xl font-semibold mb-1">
          {mode === 'login' ? 'Welcome back' : 'Create your Distro account'}
        </h1>
        <p className="text-sm text-bolt-elements-textSecondary mb-6">
          {mode === 'login'
            ? 'Sign in to use your own gateway key on this Distro instance.'
            : 'Your account gets its own gateway key. The first account on an instance is the admin.'}
        </p>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            placeholder="Password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
          {error && <p className="text-sm text-bolt-elements-button-danger-text">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-semibold bg-bolt-elements-button-primary-background hover:bg-bolt-elements-button-primary-backgroundHover text-bolt-elements-button-primary-text disabled:opacity-60"
          >
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        {ssoEnabled && (
          <>
            <div className="flex items-center gap-3 my-4 text-xs text-bolt-elements-textTertiary">
              <span className="flex-1 h-px bg-bolt-elements-borderColor" />
              or
              <span className="flex-1 h-px bg-bolt-elements-borderColor" />
            </div>
            <button
              type="button"
              onClick={startOidc}
              disabled={ssoBusy}
              className="w-full rounded-lg px-4 py-2 text-sm font-semibold border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 hover:bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary disabled:opacity-60"
            >
              {ssoBusy ? 'Signing in…' : 'Continue with Authentik'}
            </button>
          </>
        )}

        <p className="text-sm text-bolt-elements-textSecondary mt-4 text-center">
          {mode === 'login' ? (
            <>
              No account yet?{' '}
              <button type="button" className="text-bolt-elements-item-contentAccent underline" onClick={() => setMode('signup')}>
                Create one
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button type="button" className="text-bolt-elements-item-contentAccent underline" onClick={() => setMode('login')}>
                Sign in
              </button>
            </>
          )}
        </p>

        <p className="text-xs text-bolt-elements-textTertiary mt-8 text-center">
          {CONTROL_PLANE_ENABLED ? (
            <>
              Multi-user mode is on — each account is billed/tracked via its own
              gateway key.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  window.localStorage.setItem('distro_host_mode', '1');
                  navigate('/app', { replace: true });
                }}
              >
                Skip for now (host key)
              </button>
            </>
          ) : (
            <a href="/app" className="underline">
              Continue to the app
            </a>
          )}
        </p>
      </div>
    </div>
  );
}
