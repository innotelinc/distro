// Spend estimation (USD) for gateway usage rows.
//
// OmniRoute's usage_history stores tokens but not cost — the dashboard
// computes cost from provider pricing at read time. Distro keeps a small,
// curated price table keyed by model-name fragments and falls back to a
// conservative default. Estimates feed usage_cache.cost_usd so quota spend
// caps and the admin console have meaningful numbers; gateway-enforced USD
// key limits remain authoritative.
//
// Prices are per million tokens (input / output), USD. Review occasionally —
// they are estimates, not billing.

const RATES = [
  // Anthropic
  { match: /claude-(3\.[57]|4)/i, in: 3, out: 15 },
  { match: /claude-3-haiku|claude-3-5-haiku/i, in: 0.8, out: 4 },
  // OpenAI
  { match: /gpt-4o1?|o1-|o3-|gpt-5/i, in: 2.5, out: 10 },
  { match: /gpt-4o-mini/i, in: 0.15, out: 0.6 },
  { match: /gpt-4(o|-turbo)/i, in: 2.5, out: 10 },
  // Google / Gemini
  { match: /gemini.*(pro|ultra)/i, in: 1.25, out: 5 },
  { match: /gemini.*flash/i, in: 0.3, out: 1.5 },
  // DeepSeek
  { match: /deepseek/i, in: 0.27, out: 1.1 },
  // Groq (LPU-hosted OSS)
  { match: /groq|llama-3|llama-4/i, in: 0.2, out: 0.8 },
  // Mistral
  { match: /mistral/i, in: 0.3, out: 0.9 },
  // Qwen
  { match: /qwen/i, in: 0.2, out: 1.0 },
  // OpenRouter generic is priced per model upstream; fall through to default.
];

// Conservative default for anything unmapped (many gateway free tiers cost
// less; paid frontier models cost more — the default sits mid-range).
const DEFAULT_RATES = { in: 1, out: 3 };

function ratesForModel(model) {
  const name = String(model || '');
  for (const r of RATES) {
    if (r.match.test(name)) return r;
  }
  return DEFAULT_RATES;
}

/** Estimated USD cost for a usage row. */
export function estimateCostUsd(model, tokensIn, tokensOut) {
  const { in: rateIn, out: rateOut } = ratesForModel(model);
  return (Math.max(0, tokensIn) / 1e6) * rateIn + (Math.max(0, tokensOut) / 1e6) * rateOut;
}
