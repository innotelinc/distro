#!/usr/bin/env node
// Control-plane admin CLI.
//   node bin/control.mjs health
//   node bin/control.mjs create-admin <email> <password>
//   node bin/control.mjs users
//   node bin/control.mjs gateway-check
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDb, createUser, userCount, listUsers, getQuota, getGatewayKey, getDb } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { GatewayClient } from '../src/gateway.js';
import { syncUsageFromGateway } from '../src/sync.js';

const here = dirname(fileURLToPath(import.meta.url));
openDb(process.env.CONTROL_DB_PATH || join(here, '..', 'data', 'control.sqlite'));

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'health': {
      console.log('users:', userCount());
      break;
    }
    case 'create-admin': {
      const [email, password] = args;
      if (!email || !password || password.length < 8) {
        console.error('usage: control.mjs create-admin <email> <password>');
        process.exit(1);
      }
      if (createUser({ email, passwordHash: hashPassword(password), role: 'admin' })) {
        console.log(`admin created: ${email}`);
      } else {
        console.error('could not create admin (duplicate email?)');
        process.exit(1);
      }
      break;
    }
    case 'users': {
      for (const u of listUsers()) {
        console.log(
          `${u.role.padEnd(5)} ${u.email} key=${getGatewayKey(u.id) ? 'yes' : 'no'} disabled=${!!u.disabled_at} quota=${JSON.stringify(getQuota(u.id))}`,
        );
      }
      break;
    }
    case 'gateway-check': {
      const gateway = new GatewayClient({
        dashboardUrl: process.env.GATEWAY_DASHBOARD_URL,
        adminPassword: process.env.GATEWAY_ADMIN_PASSWORD,
      });
      try {
        await gateway.login();
        const keys = await gateway.listApiKeys();
        console.log(`gateway reachable; ${keys.length} gateway API key(s)`);
      } catch (err) {
        console.error('gateway check failed:', err.message);
        process.exit(1);
      }
      break;
    }
    case 'usage-sync': {
      const result = await syncUsageFromGateway();
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'test-alert': {
      // Fires a synthetic alert to CONTROL_ALERT_WEBHOOK_URL (verifies the
      // receiver and records the delivery in alert_log).
      const { alert } = await import('../src/alerts.js');
      const result = await alert('test', {
        title: 'Distro test alert',
        message: 'If you can read this, webhook delivery works.',
        meta: { source: 'cli' },
      });
      console.log(JSON.stringify(result));
      if (!result.sent) process.exit(1);
      break;
    }
    case 'backup': {
      // Online SQLite backup via better-sqlite3 .backup() — safe while live.
      const outDir = args[0] || join(here, '..', 'data', 'backups');
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const dest = join(outDir, `control-${stamp}.sqlite`);
      const db = getDb();
      await db.backup(dest);
      console.log(`backup written: ${dest}`);
      break;
    }
    default:
      console.error('usage: control.mjs <health|create-admin|users|gateway-check|usage-sync|test-alert|backup>');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
