import { useEffect, useState } from 'react';
import type { MetaFunction } from '@remix-run/cloudflare';
import {
  controlPlaneBase,
  CONTROL_PLANE_ENABLED,
  getStoredToken,
} from '~/lib/control-plane';
import BackgroundRays from '~/components/ui/BackgroundRays';

export const meta: MetaFunction = () => {
  return [{ title: 'Billing — Distro' }];
};

interface Entitlement {
  entitled: boolean | null;
  source: string;
  magnate_url: string;
  plan?: string | null;
  status?: string | null;
  expires_at?: number | null;
  reason?: string | null;
}

interface Plan {
  id: number;
  name: string;
  slug: string;
  description?: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  features: string[];
  highlighted?: boolean;
}

export default function Billing() {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!CONTROL_PLANE_ENABLED) {
      setLoading(false);
      return;
    }
    const token = getStoredToken();
    if (!token) {
      setLoading(false);
      return;
    }

    const base = controlPlaneBase();
    const headers = { Authorization: `Bearer ${token}` };

    Promise.all([
      fetch(`${base}/api/billing/entitlements`, { headers }).then((r) => r.json()),
      fetch(`${base}/api/billing/plans`, { headers }).then((r) => r.json()),
    ])
      .then(([ent, planData]) => {
        setEntitlement(ent);
        setPlans(planData.plans || []);
      })
      .catch((err) => setError(err?.message || 'Failed to load billing info'))
      .finally(() => setLoading(false));
  }, []);

  const handleCheckout = async (planSlug: string, interval: 'month' | 'year') => {
    setCheckoutBusy(true);
    setError('');
    try {
      const base = controlPlaneBase();
      const token = getStoredToken();
      const res = await fetch(`${base}/api/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ planSlug, interval }),
      });
      const data = await res.json();
      if (data.url) {
        window.open(data.url, '_blank');
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err: any) {
      setError(err?.message || 'Checkout failed');
    } finally {
      setCheckoutBusy(false);
    }
  };

  if (!CONTROL_PLANE_ENABLED) {
    return (
      <div className="flex h-screen items-center justify-center bg-bolt-elements-background">
        <BackgroundRays />
        <div className="relative z-10 text-center">
          <h1 className="text-2xl font-bold text-bolt-elements-textPrimary">Billing</h1>
          <p className="mt-2 text-bolt-elements-textSecondary">
            Billing is not enabled. Enable the control plane to manage subscriptions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-bolt-elements-background">
      <BackgroundRays />
      <div className="relative z-10 mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-3xl font-bold text-bolt-elements-textPrimary">Billing & Subscription</h1>
        <p className="mt-2 text-bolt-elements-textSecondary">
          Manage your Distro subscription via Magnate (RevenueOps in the Innotel Platform Stack).
          Magnate owns Stripe, plans and the revenue ledger; Distro only checks
          entitlements server-to-server.
        </p>

        {/* Current Status */}
        <div className="mt-8 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-6">
          <h2 className="text-lg font-semibold text-bolt-elements-textPrimary">Current Plan</h2>
          {loading ? (
            <p className="mt-2 text-bolt-elements-textSecondary">Loading...</p>
          ) : entitlement ? (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-bolt-elements-textSecondary">Status:</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    entitlement.entitled === true
                      ? 'bg-green-500/20 text-green-400'
                      : entitlement.entitled === false
                        ? 'bg-red-500/20 text-red-400'
                        : 'bg-yellow-500/20 text-yellow-400'
                  }`}
                >
                  {entitlement.entitled === true
                    ? 'Active'
                    : entitlement.entitled === false
                      ? 'Inactive'
                      : 'Unknown'}
                </span>
              </div>
              {entitlement.plan && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-bolt-elements-textSecondary">Plan:</span>
                  <span className="text-sm font-medium text-bolt-elements-textPrimary">
                    {entitlement.plan}
                  </span>
                </div>
              )}
              {entitlement.expires_at && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-bolt-elements-textSecondary">Expires:</span>
                  <span className="text-sm text-bolt-elements-textPrimary">
                    {new Date(entitlement.expires_at * 1000).toLocaleDateString()}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-sm text-bolt-elements-textSecondary">Source:</span>
                <span className="text-sm text-bolt-elements-textPrimary">
                  {entitlement.source === 'magnate' ? 'Magnate (live)' : entitlement.source}
                </span>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-bolt-elements-textSecondary">No subscription found.</p>
          )}
        </div>

        {/* Available Plans */}
        {plans.length > 0 && (
          <div className="mt-8">
            <h2 className="text-lg font-semibold text-bolt-elements-textPrimary">Available Plans</h2>
            <div className="mt-4 grid gap-4">
              {plans.map((plan) => (
                <div
                  key={plan.id}
                  className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-6"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-bolt-elements-textPrimary">
                        {plan.name}
                      </h3>
                      <p className="mt-1 text-sm text-bolt-elements-textSecondary">
                        {plan.description}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-bolt-elements-textPrimary">
                        ${(plan.priceMonthlyCents / 100).toFixed(2)}
                      </div>
                      <div className="text-xs text-bolt-elements-textSecondary">/month</div>
                    </div>
                  </div>
                  {plan.features && plan.features.length > 0 && (
                    <ul className="mt-4 space-y-1">
                      {plan.features.map((f, i) => (
                        <li key={i} className="flex items-center gap-2 text-sm text-bolt-elements-textSecondary">
                          <span className="text-green-400">✓</span>
                          {f}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={() => handleCheckout(plan.slug, 'month')}
                      disabled={checkoutBusy}
                      className="rounded-lg bg-bolt-elements-button-primary-background px-4 py-2 text-sm font-medium text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover disabled:opacity-50"
                    >
                      {checkoutBusy ? 'Loading...' : 'Subscribe Monthly'}
                    </button>
                    <button
                      onClick={() => handleCheckout(plan.slug, 'year')}
                      disabled={checkoutBusy}
                      className="rounded-lg border border-bolt-elements-borderColor px-4 py-2 text-sm font-medium text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-1 disabled:opacity-50"
                    >
                      {checkoutBusy ? 'Loading...' : 'Subscribe Yearly'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="mt-8 text-center">
          <a
            href="/app"
            className="text-sm text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
          >
            ← Back to Distro
          </a>
        </div>
      </div>
    </div>
  );
}
