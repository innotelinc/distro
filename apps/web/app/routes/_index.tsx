import type { MetaFunction } from '@remix-run/cloudflare';
import BackgroundRays from '~/components/ui/BackgroundRays';

export const meta: MetaFunction = () => {
  return [
    { title: 'Distro — build apps with AI, in your browser' },
    {
      name: 'description',
      content:
        'Distro is a self-hosted AI app-building platform: describe an app and the agent writes, runs, previews, and iterates on a full-stack codebase in your browser.',
    },
  ];
};

const FEATURES = [
  {
    title: 'Chat-to-code agent',
    body: 'Describe an app in plain language. Distro writes files, installs packages, runs the dev server, and shows a live preview — then keeps iterating with you.',
  },
  {
    title: 'Your own model gateway',
    body: 'Every request flows through a self-hosted OmniRoute gateway: one OpenAI-compatible endpoint in front of hundreds of upstream providers, with fallback and token accounting.',
  },
  {
    title: 'Self-hosted & single-tenant-clean',
    body: 'No cloud, no credits, no vendor lock-in. Upstream provider API keys live in the gateway — Distro never sees them. Multi-tenant auth and per-user quotas are the roadmap.',
  },
];

const EXAMPLES = [
  'Build a todo app in React using Tailwind',
  'Build a simple blog using Astro',
  'Make a space invaders game',
];

export default function Index() {
  return (
    <div className="relative flex flex-col min-h-full overflow-y-auto bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary">
      <BackgroundRays />

      <header className="flex items-center justify-between p-6 max-w-6xl mx-auto w-full">
        <a href="/" className="flex items-center gap-2 text-xl font-semibold select-none">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
            <defs>
              <linearGradient id="distro-mark-lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#06b6d4" />
                <stop offset="100%" stopColor="#6366f1" />
              </linearGradient>
            </defs>
            <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#distro-mark-lg)" />
            <g fill="#ffffff">
              <circle cx="16" cy="16" r="3.6" />
              <circle cx="16" cy="6.9" r="2.2" />
              <circle cx="24.5" cy="21" r="2.2" />
              <circle cx="7.5" cy="21" r="2.2" />
            </g>
          </svg>
          <span>Distro</span>
        </a>
        <a
          href="/app"
          className="text-sm font-medium rounded-lg px-4 py-2 bg-bolt-elements-button-primary-background hover:bg-bolt-elements-button-primary-backgroundHover text-bolt-elements-button-primary-text"
        >
          Open the app
        </a>
      </header>

      <main className="flex-1 flex flex-col items-center text-center px-6 max-w-6xl mx-auto w-full">
        <section className="mt-[10vh] mb-16">
          <p className="text-sm uppercase tracking-widest text-bolt-elements-textSecondary mb-6">
            Self-hosted · in-browser · AI app building
          </p>
          <h1 className="text-4xl lg:text-6xl font-bold leading-tight mb-6">
            Describe an app.
            <br />
            <span className="bg-gradient-to-r from-cyan-500 to-indigo-500 bg-clip-text text-transparent">
              Watch it get built.
            </span>
          </h1>
          <p className="text-lg text-bolt-elements-textSecondary max-w-2xl mx-auto mb-10">
            Distro runs a full-stack coding agent in your browser — writing files, installing
            dependencies, and previewing your app live, all routed through your own AI gateway.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="/app"
              className="rounded-xl px-6 py-3 text-base font-semibold bg-bolt-elements-button-primary-background hover:bg-bolt-elements-button-primary-backgroundHover text-bolt-elements-button-primary-text"
            >
              Start building →
            </a>
            <a
              href="/app?prompt=Build%20a%20todo%20app%20in%20React%20using%20Tailwind"
              className="rounded-xl px-6 py-3 text-base font-medium border border-bolt-elements-borderColor text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2"
            >
              Try an example
            </a>
          </div>
        </section>

        <section className="grid md:grid-cols-3 gap-6 w-full mb-16 text-left">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-6"
            >
              <h2 className="text-lg font-semibold mb-2">{feature.title}</h2>
              <p className="text-sm text-bolt-elements-textSecondary leading-relaxed">{feature.body}</p>
            </div>
          ))}
        </section>

        <section className="w-full mb-16">
          <h2 className="text-2xl font-semibold mb-6 text-center">What can you build?</h2>
          <div className="flex flex-wrap justify-center gap-2">
            {EXAMPLES.map((example) => (
              <a
                key={example}
                href={`/app?prompt=${encodeURIComponent(example)}`}
                className="rounded-full border border-bolt-elements-borderColor px-4 py-2 text-sm text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 transition-theme"
              >
                {example}
              </a>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-bolt-elements-borderColor py-8 text-center text-xs text-bolt-elements-textTertiary">
        <p>
          Distro is built from the MIT-licensed{' '}
          <a
            href="https://github.com/stackblitz-labs/bolt.diy"
            className="text-bolt-elements-textSecondary underline"
          >
            bolt.diy
          </a>{' '}
          and{' '}
          <a href="https://github.com/diegosouzapw/OmniRoute" className="text-bolt-elements-textSecondary underline">
            OmniRoute
          </a>{' '}
          projects. Attribution is retained in our license notices.
        </p>
      </footer>
    </div>
  );
}
