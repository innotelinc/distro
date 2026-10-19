/**
 * Credits: what a metered add-on spends, and the ledger that remembers it.
 *
 * A credit is a unit of *work*, not of time. OnTrak Engineer charges one credit to
 * reverse-engineer one project — so the unit is something a customer can hold in
 * their head, and the price of it is set where money is set (Magnate: $5), never
 * here. This module owns the other half: **the balance**.
 *
 * THE LEDGER IS APPEND-ONLY, AND THAT IS THE WHOLE DESIGN
 * -------------------------------------------------------
 * A balance stored as a number can be overwritten, and a balance that was
 * overwritten cannot answer the two questions anyone asks about a metered service:
 * *who spent this* and *when*. So every change is a row — a grant (`+`), a spend
 * (`-`), an adjustment with a reason — and the balance is their sum. It is a few
 * rows per project, which is nothing next to what the project costs to run.
 *
 * TWO PROPERTIES THE SPEND PATH GUARANTEES
 * ----------------------------------------
 *   * **A charge cannot go below zero.** The check and the insert happen in one
 *     transaction, so two concurrent spends cannot both see the same balance.
 *   * **A retry is not a second charge.** A spend carries a `reference` — the
 *     project id, in the case this was written for — and `(user, product,
 *     reference)` is unique. Running the same project twice charges once; running
 *     a second project charges again.
 *
 * Service accounts are the platform's own machines. They have no subscription and
 * no limits anywhere else in the plane (see `isServicePlan` in `billing.js`), and a
 * credit balance is a subscription's currency, so they are answered as unlimited
 * rather than being given an enormous number of credits.
 */

import { randomUUID } from "node:crypto";

import { getDb } from "./db.js";

/**
 * What the unit costs, for display.
 *
 * Magnate is the price list — it is the only place a price is *set* — and this is
 * the copy a caller is told so a panel can say "$5 a credit" without a second
 * round trip. `CONTROL_CREDIT_PRICE_USD` exists so a deployment can state it once;
 * the default matches the plan Magnate sells.
 */
export function creditPriceUsd() {
  const raw = Number.parseFloat(process.env.CONTROL_CREDIT_PRICE_USD ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
}

/** How many credits one project costs. A setting because pricing is a decision. */
export function creditsPerProject() {
  const raw = Number.parseInt(process.env.CONTROL_CREDITS_PER_PROJECT ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** The balance: the sum of every change, which is the only way it is ever derived. */
export function creditBalance(userId, product = "engineer") {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_ledger WHERE user_id = ? AND product = ?")
    .get(userId, product);
  return row?.balance ?? 0;
}

/** The ledger, newest first — what a person sees when they ask where their credits went. */
export function creditHistory(userId, { product = "engineer", limit = 50 } = {}) {
  return getDb()
    .prepare(
      `SELECT id, delta, kind, product, reference, reason, actor_email, created_at
         FROM credit_ledger
        WHERE user_id = ? AND product = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(userId, product, Math.max(1, Math.min(Number(limit) || 50, 500)));
}

/**
 * Add credits, and say what the balance is now.
 *
 * Used for a purchase (Magnate settles the money, this records the units), for an
 * operator's goodwill grant, and for a correction. `reference` is optional here —
 * a purchase has an order id and should pass it, so a webhook delivered twice
 * grants once.
 */
export function grantCredits({ userId, credits, reason = null, reference = null, product = "engineer", actorEmail = null }) {
  const amount = Math.trunc(Number(credits));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("credits must be a positive whole number");

  const db = getDb();
  const existing = reference === null ? null : findReference(db, userId, product, reference);
  if (existing) {
    // The same purchase arriving twice is the same purchase.
    return { granted: 0, duplicate: true, balance: creditBalance(userId, product), entry: existing };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO credit_ledger (id, user_id, delta, kind, product, reference, reason, actor_email)
     VALUES (?, ?, ?, 'grant', ?, ?, ?, ?)`,
  ).run(id, userId, amount, product, reference, reason, actorEmail);

  return { granted: amount, duplicate: false, balance: creditBalance(userId, product), entry: { id } };
}

function findReference(db, userId, product, reference) {
  return db
    .prepare("SELECT id, delta, created_at FROM credit_ledger WHERE user_id = ? AND product = ? AND reference = ?")
    .get(userId, product, reference);
}

/**
 * Spend credits, or refuse and say why.
 *
 * Returns a verdict rather than throwing, because "not enough credits" is an
 * *answer* — the caller passes it to whoever asked, and a 402 for a customer in
 * good standing should carry a balance they can act on, not an exception.
 */
export function spendCredits({
  userId,
  credits = creditsPerProject(),
  product = "engineer",
  reference = null,
  reason = null,
  actorEmail = null,
}) {
  const amount = Math.trunc(Number(credits));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "invalid_amount", balance: creditBalance(userId, product), spent: 0 };
  }

  const db = getDb();

  // One transaction: the read and the write that depends on it. Without this, two
  // projects started at the same moment could each see the last credit.
  const run = db.transaction(() => {
    if (reference !== null) {
      const existing = findReference(db, userId, product, reference);
      if (existing) {
        return { ok: true, duplicate: true, spent: 0, balance: creditBalance(userId, product), entry: existing };
      }
    }

    const balance = creditBalance(userId, product);
    if (balance < amount) {
      return { ok: false, code: "insufficient_credits", balance, spent: 0, required: amount };
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, delta, kind, product, reference, reason, actor_email)
       VALUES (?, ?, ?, 'spend', ?, ?, ?, ?)`,
    ).run(id, userId, -amount, product, reference, reason, actorEmail);

    return { ok: true, duplicate: false, spent: amount, balance: balance - amount, entry: { id } };
  });

  try {
    return run();
  } catch (error) {
    // The unique index on (user, product, reference) is the last line of defence:
    // a second concurrent charge for the same project loses here instead of
    // charging twice.
    if (String(error?.message || "").includes("UNIQUE")) {
      return { ok: true, duplicate: true, spent: 0, balance: creditBalance(userId, product) };
    }
    throw error;
  }
}

/**
 * One answer for a product asking "may this account start another project".
 *
 * The shape is the entitlement answer's, because a product already knows how to
 * read that one: `allowed` says it, `balance` says how much is left, and a service
 * account is unlimited. `price_per_credit_usd` and `credits_per_project` are here
 * so a panel can explain the charge without asking Magnate or being told again.
 */
export function creditStatus({ userId, product = "engineer", service = false }) {
  const price = creditPriceUsd();
  const perProject = creditsPerProject();
  if (service) {
    return {
      service: true,
      allowed: true,
      unlimited: true,
      balance: null,
      credits_per_project: perProject,
      price_per_credit_usd: price,
      reason: "service account: no subscription, no limits",
    };
  }

  const balance = creditBalance(userId, product);
  return {
    service: false,
    allowed: balance >= perProject,
    unlimited: false,
    balance,
    credits_per_project: perProject,
    price_per_credit_usd: price,
    reason: balance >= perProject ? "credits available" : "no credits left",
  };
}
