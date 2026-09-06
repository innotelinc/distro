#!/usr/bin/env node
// Control-plane admin CLI.
//   node bin/control.mjs health
//   node bin/control.mjs create-admin <email> <password>
//   node bin/control.mjs users
//   node bin/control.mjs gateway-check
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, createUser, userCount, listUsers, getQuota, getGatewayKey } from '../src/db.js';
import { hashPassword } from '../src/passwords.js';
import { GatewayClient } from '../src/gateway.js';

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
    default:
      console.error('usage: control.mjs <health|create-admin|users|gateway-check>');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
