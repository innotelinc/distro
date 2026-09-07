# 🧩 Distro — Platform Stack Role

**Classification: BuilderOps**

Self-hosted AI app-building platform: describe an application and Distro's
agent writes, runs, previews, and iterates on a full-stack codebase in the
browser — no local dev environment required.

This page declares Distro's role in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture. The stack is defined in
exactly one place; this page links each product to it and states what this
platform owns, consumes, provides, and explicitly does not own.

## Owns

- The in-browser builder shell (fork of bolt.diy): chat-to-code agent UI,
  WebContainer sandbox, live preview, file tree, terminal
- Running and iterating on the apps a user asks for (in-browser execution)
- Multi-tenant accounts for the builder (Distro control plane): signup/login,
  one OmniRoute gateway key per user, quota/usage enforcement, admin console
- Per-user model spend accounting and webhook alerting

## Provides

- An AI app-building front door for the ecosystem: browser → Distro →
  OmniRoute gateway → upstream models
- Per-user gateway keys + quotas so builder traffic is attributable and capped

## Consumes

- OmniRoute — the AI plane (OpenAI-compatible gateway to upstream model
  providers). Distro never holds upstream provider keys.
- NPM Edge — public TLS routing and hostnames (`slots.innotel.us`: web at `/`,
  control plane at `/cp`)
- Infisical — secrets target for gateway/control-plane credentials (currently
  `.env` on the host; see convergence note)

## Explicitly does NOT own

- Identity (Authentik) — Distro runs its own control-plane accounts today;
  Authentik SSO is the convergence target
- Secrets (Infisical)
- Certificates / DNS / trust (Cerulean) — the NPM edge terminates TLS
- Storage (ONYX)
- Billing (Magnate)
- The LLM gateway itself (OmniRoute) — it is an ecosystem extension
  (`extensions/llm`) that any group may enable

> **Current state:** the live deployment bundles its own OmniRoute gateway and
> control-plane accounts inside Distro's compose stack. Convergence targets:
> consume the shared `omniroute-llm` extension for the AI plane, move secrets
> into Infisical, and adopt Authentik as the identity provider.
