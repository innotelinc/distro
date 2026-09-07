#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# seed-distro-plan.sh — Create the "distro" plan in Magnate's SQLite database
#
# Run after Magnate is up:
#   ./scripts/seed-distro-plan.sh
#
# This seeds a single plan with slug "distro" that Distro checks via the
# entitlements API. Adjust prices/features as needed.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

MAGNATE_CONTAINER="${MAGNATE_CONTAINER:-distro-magnate}"
DB_PATH="/data/storage.sqlite"

echo "==> Checking if Magnate is running..."
if ! docker inspect "$MAGNATE_CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: container $MAGNATE_CONTAINER not found. Start Magnate first."
  exit 1
fi

echo "==> Seeding distro plan in $MAGNATE_CONTAINER..."
docker exec "$MAGNATE_CONTAINER" node -e "
const Database = require('better-sqlite3');
const db = new Database('$DB_PATH');

// Create plans table if it doesn't exist (Magnate's schema)
db.exec(\`
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    price_monthly_cents INTEGER NOT NULL DEFAULT 0,
    price_yearly_cents INTEGER NOT NULL DEFAULT 0,
    stripe_product_id TEXT,
    stripe_price_monthly_id TEXT,
    stripe_price_yearly_id TEXT,
    features TEXT NOT NULL DEFAULT '[]',
    highlighted INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
\`);

// Insert the distro plan (upsert by slug)
const existing = db.prepare('SELECT id FROM plans WHERE slug = ?').get('distro');
if (existing) {
  console.log('Plan \"distro\" already exists (id=' + existing.id + '), updating...');
  db.prepare(\`
    UPDATE plans SET
      name = 'Distro',
      description = 'AI app-building platform — unlimited builds, all models.',
      price_monthly_cents = 1999,
      price_yearly_cents = 19990,
      features = ?,
      active = 1,
      sort_order = 0
    WHERE slug = 'distro'
  \`).run(JSON.stringify([
    'Unlimited app builds',
    'Access to all AI models via OmniRoute',
    'Live preview & terminal in-browser',
    'Priority support'
  ]));
  console.log('Updated distro plan.');
} else {
  db.prepare(\`
    INSERT INTO plans (name, slug, description, price_monthly_cents, price_yearly_cents, features, highlighted, active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  \`).run(
    'Distro',
    'distro',
    'AI app-building platform — unlimited builds, all models.',
    1999,  // \$19.99/month
    19990, // \$199.90/year
    JSON.stringify([
      'Unlimited app builds',
      'Access to all AI models via OmniRoute',
      'Live preview & terminal in-browser',
      'Priority support'
    ]),
    1,  // highlighted
    1,  // active
    0   // sort_order
  );
  console.log('Created distro plan (id=' + db.prepare('SELECT last_insert_rowid() as id').get().id + ')');
}

db.close();
console.log('Done.');
"

echo "==> Verifying plan exists..."
docker exec "$MAGNATE_CONTAINER" node -e "
const Database = require('better-sqlite3');
const db = new Database('$DB_PATH');
const plan = db.prepare('SELECT * FROM plans WHERE slug = ?').get('distro');
if (plan) {
  console.log('✓ Plan found: ' + plan.name + ' (slug: ' + plan.slug + ', \$' + (plan.price_monthly_cents/100).toFixed(2) + '/mo)');
} else {
  console.error('✗ Plan not found!');
  process.exit(1);
}
db.close();
"

echo "==> Done! Distro can now check entitlements via:"
echo "    GET /api/entitlements?plan=distro&user=<email>"
