#!/usr/bin/env node
// Control-plane admin CLI.
//   node bin/control.mjs health
//   node bin/control.mjs create-admin <email> <password>
//   node bin/control.mjs users
//   node bin/control.mjs delete-user <email>
//   node bin/control.mjs gateway-check
//   node bin/control.mjs keys-check [--fix] [--alert]
//   node bin/control.mjs acceptance
//   node bin/control.mjs accounts [limit]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDb, createUser, userCount, listUsers, getQuota, getGatewayKey, getUserByEmail, getDb } from '../src/db.js';
import { deleteAccount } from '../src/accounts.js';
import { hashPassword } from '../src/passwords.js';
import { GatewayClient } from '../src/gateway.js';
import { syncUsageFromGateway } from '../src/sync.js';
import { checkGatewayVersion } from '../src/gatewayVersion.js';
import { checkAccountKeys, remintAccountKey } from '../src/accountKeys.js';
import { runAcceptance, formatAcceptance, linkedAccountPairs } from '../src/acceptance.js';

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
    case 'delete-user': {
      // The row and the gateway key are two pieces of state, and the key is the
      // one that keeps spending after the account is gone. So the revoke comes
      // first: if the gateway will not take it back, nothing is deleted and the
      // command says so, rather than leaving a credential nobody can attribute.
      const [email] = args;
      if (!email) {
        console.error('usage: control.mjs delete-user <email>');
        process.exit(1);
      }
      const user = getUserByEmail(email);
      if (!user) {
        console.error(`no such account: ${email}`);
        process.exit(1);
      }
      const key = getGatewayKey(user.id);
      const gateway = new GatewayClient({ adminPassword: process.env.GATEWAY_ADMIN_PASSWORD });
      try {
        await deleteAccount(user, { gateway });
      } catch (err) {
        console.error(`could not delete ${user.email}: ${err.message}`);
        console.error('the account is untouched — fix the gateway and run this again');
        process.exit(1);
      }
      console.log(
        key
          ? `deleted ${user.email} (gateway key ${key.gateway_key_id} revoked)`
          : `deleted ${user.email} (no gateway key)`,
      );
      break;
    }
    case 'gateway-check': {
      const gateway = new GatewayClient({
        adminPassword: process.env.GATEWAY_ADMIN_PASSWORD,
      });
      try {
        await gateway.login();
        const keys = await gateway.listApiKeys();
        console.log(`gateway reachable; ${keys.length} gateway API key(s)`);
        const version = await checkGatewayVersion(gateway, { log: { warn: () => {} } });
        console.log(
          `gateway version: ${version.running || 'unknown'} — pin ${version.expected || 'none'} → ` +
            (version.compatible === true ? 'compatible' : version.compatible === false ? 'MISMATCH' : 'unchecked') +
            (version.error ? ` (${version.error})` : ''),
        );
      } catch (err) {
        console.error('gateway check failed:', err.message);
        process.exit(1);
      }
      break;
    }
    case 'keys-check': {
      // Does every account's key still open the gateway? A key the gateway
      // refuses stops every turn for that account before a model is chosen, and
      // the builder surface reports that as "every model failed to answer" —
      // a credential problem wearing a model problem's coat.
      const fix = args.includes('--fix');
      const gateway = new GatewayClient({ adminPassword: process.env.GATEWAY_ADMIN_PASSWORD });
      const result = await checkAccountKeys();
      console.log(`gateway ${result.base} — ${result.checked} live account key(s)`);
      for (const entry of result.rejected) {
        console.log(`  REFUSED   ${entry.email} ${entry.keyPrefix}… HTTP ${entry.status}`);
      }
      for (const entry of result.unchecked) {
        console.log(`  unchecked ${entry.email} ${entry.keyPrefix}… ${entry.error || 'HTTP ' + entry.status}`);
      }
      if (result.rejected.length === 0) {
        console.log(`  ok        every key accepted (${result.ok.length}/${result.checked})`);
      } else if (fix) {
        for (const entry of result.rejected) {
          const minted = await remintAccountKey(entry, { gateway });
          console.log(`  re-minted ${entry.email} → gateway key ${minted.gatewayKeyId}`);
        }
      }
      if (result.rejected.length > 0 && args.includes('--alert')) {
        // The same shape as the other operational alerts, so one receiver can
        // classify them: see CONTROL_ALERT_WEBHOOK_URL in docs/ops.md.
        const { alert } = await import('../src/alerts.js');
        await alert('gateway.account-keys', {
          title: 'The gateway refused an account key',
          message:
            `${result.rejected.length} account key(s) refused: ` +
            result.rejected.map((entry) => `${entry.email} (HTTP ${entry.status})`).join(', '),
          meta: {
            base: result.base,
            unchecked: result.unchecked.length,
            rejected: result.rejected.map((entry) => ({
              email: entry.email,
              status: entry.status,
              keyPrefix: entry.keyPrefix,
            })),
          },
        });
      }
      // Non-zero so a timer or a CI step notices. --fix is the human saying
      // "rotate it", and exits 0 because the finding is then resolved.
      if (result.rejected.length > 0 && !fix) process.exit(1);
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
    case 'acceptance': {
      // Prove the loop the tenancy layer exists for, end to end, against *this*
      // deployment — not against a description of it. A scheduled check, because
      // the failure it catches (a key the gateway forgot, a plane that stopped
      // answering, accounting that stopped being written) is invisible until
      // somebody's turn dies, and by then it is reported as a model problem.
      //
      // It is the M7 cross-repository acceptance item's plane half: a subject
      // resolves to an account (provisioned on first sight), the account's own
      // gateway key is what every later call carries, the quota gate answers, a
      // turn's usage is reported and reads back through the same route a turn's
      // accounting uses. The sign-in half lives with the surface that signs in
      // (`ontrak-genie/scripts/verify-tenancy.mjs`), so this half needs no
      // Authentik, provider or Cerulean credential.
      //
      // It uses one dedicated account (`ACCEPTANCE_EMAIL`, default
      // `acceptance@distro.invalid`) and reports one turn of usage against it, so
      // it is self-contained and leaves the other accounts untouched.
      const base = String(
        process.env.CONTROL_PLANE_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 20140}`,
      ).replace(/\/+$/, '');
      const token = String(process.env.CONTROL_INTERNAL_TOKEN || '');
      if (!token) {
        console.error(
          'acceptance: CONTROL_INTERNAL_TOKEN is not set. The internal routes are OFF (503) rather\n' +
            'than open, so there is no loop to check from here.',
        );
        process.exit(1);
      }
      const sub = process.env.ACCEPTANCE_SUB || undefined;
      const email = process.env.ACCEPTANCE_EMAIL || undefined;

      console.log(`acceptance ${base}${email ? ` — ${email}` : ''}`);
      const result = await runAcceptance({ base, token, sub, email });
      console.log(formatAcceptance(result));
      // Non-zero so a timer unit fails and cron mails: the same posture as keys-check.
      if (!result.ok) process.exit(1);
      break;
    }
    case 'accounts': {
      // The accounts the cross-repository check signs in as, in the flag shape
      // `ontrak-genie/scripts/verify-tenancy.mjs` takes (`sub=email`). The whole
      // point is that the *plane* names them: a check that invented a subject
      // would prove the console mints a cookie, not that the accounts people use
      // resolve here. Printed as data so a shell can pass it straight through.
      const limit = Number(args[0]) > 0 ? Number(args[0]) : 2;
      for (const pair of linkedAccountPairs(listUsers(), limit)) console.log(pair);
      break;
    }
    default:
      console.error(
      'usage: control.mjs <health|create-admin|users|delete-user|gateway-check|keys-check|usage-sync|test-alert|backup|acceptance|accounts>',
    );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
