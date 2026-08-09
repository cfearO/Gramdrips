import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Point DATA_DIR at a mounted persistent volume in production (Railway
// Volumes, Render persistent disks) — otherwise this resets on every
// redeploy/restart. See backend/README.md "Persistent storage" section.
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
const DB_PATH = join(DATA_DIR, 'db.json');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function emptyDb() {
  return {
    users: {},             // wallet -> { wallet, referralCode, referredBy, createdAt }
    collects: [],            // { wallet, index, amount, dayKey, at }
    referralEarnings: [],    // { toWallet, fromWallet, amount, at }
    withdrawals: [],         // { wallet, amount, at }  — ledger only, see server.js /api/withdraw
  };
}

function load() {
  if (!existsSync(DB_PATH)) {
    const db = emptyDb();
    save(db);
    return db;
  }
  try {
    return JSON.parse(readFileSync(DB_PATH, 'utf-8'));
  } catch {
    return emptyDb();
  }
}

function save(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Simple in-process lock so concurrent requests don't interleave read-modify-write.
// Good enough for a single-process demo; a real DB handles this properly.
let queue = Promise.resolve();
function withDb(fn) {
  const result = queue.then(() => {
    const db = load();
    const out = fn(db);
    save(db);
    return out;
  });
  queue = result.catch(() => {});
  return result;
}

function randomReferralCode() {
  return Math.random().toString(36).slice(2, 8);
}

export function getOrCreateUser(db, wallet) {
  if (!db.users[wallet]) {
    db.users[wallet] = {
      wallet,
      referralCode: randomReferralCode(),
      referredBy: null,
      withdrawalWallet: null, // the real TON address payouts go to — linked via /api/wallet/link
      withdrawalWalletVerified: false, // true only once toncenter.js confirms the public key matches on-chain
      createdAt: new Date().toISOString(),
    };
  }
  return db.users[wallet];
}

export function setWithdrawalWallet(db, identity, address, onChainVerified = false) {
  const user = getOrCreateUser(db, identity);
  user.withdrawalWallet = address;
  user.withdrawalWalletVerified = onChainVerified;
  return user;
}

export function collectsForWalletOnDay(db, wallet, dayKey) {
  return db.collects.filter((c) => c.wallet === wallet && c.dayKey === dayKey);
}

export function lastCollectForWallet(db, wallet) {
  const mine = db.collects.filter((c) => c.wallet === wallet);
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (a.at > b.at ? a : b));
}

export function referredCount(db, wallet) {
  return Object.values(db.users).filter((u) => u.referredBy === wallet).length;
}

export function totalReferralEarnings(db, wallet) {
  return db.referralEarnings
    .filter((r) => r.toWallet === wallet)
    .reduce((sum, r) => sum + r.amount, 0);
}

export function totalCollectedByWallet(db, wallet) {
  return db.collects.filter((c) => c.wallet === wallet).reduce((s, c) => s + c.amount, 0);
}

export function totalWithdrawnByWallet(db, wallet) {
  // 'pending' counts too, so a second withdrawal can't be started while the
  // first is still being broadcast (prevents double-spend on a slow send).
  // 'failed' does NOT count, restoring the balance so the user can retry.
  return db.withdrawals
    .filter((w) => w.wallet === wallet && w.status !== 'failed')
    .reduce((s, w) => s + w.amount, 0);
}

/**
 * GRAM collected but not yet withdrawn — what fills the bucket in the UI.
 */
export function withdrawableBalance(db, wallet) {
  return Number(
    (totalCollectedByWallet(db, wallet) + totalReferralEarnings(db, wallet) - totalWithdrawnByWallet(db, wallet)).toFixed(6)
  );
}

export function hasPendingWithdrawal(db, wallet) {
  return db.withdrawals.some((w) => w.wallet === wallet && w.status === 'pending');
}

/**
 * Records a withdrawal as 'pending' BEFORE attempting the on-chain send —
 * this is what blocks a second withdrawal from starting while this one is
 * still in flight. Returns the record so its id can be passed to
 * markWithdrawalSent/Failed once the send resolves.
 */
export function createPendingWithdrawal(db, wallet, amount, toAddress) {
  const record = {
    id: `${wallet}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    wallet,
    amount,
    to: toAddress,
    status: 'pending',
    at: new Date().toISOString(),
    txSeqno: null,
    error: null,
  };
  db.withdrawals.push(record);
  return record;
}

export function markWithdrawalSent(db, id, txSeqno) {
  const record = db.withdrawals.find((w) => w.id === id);
  if (record) {
    record.status = 'sent';
    record.txSeqno = txSeqno;
    record.sentAt = new Date().toISOString();
  }
}

export function markWithdrawalFailed(db, id, errorMessage) {
  const record = db.withdrawals.find((w) => w.id === id);
  if (record) {
    record.status = 'failed';
    record.error = errorMessage;
  }
}

export { withDb, load, save };
