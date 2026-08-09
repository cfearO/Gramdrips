import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, normalize } from 'path';
import {
  MAX_COLLECTS_PER_DAY,
  COOLDOWN_SECONDS,
  MAX_DAILY_SPEND,
  REFERRAL_SHARE,
  WITHDRAW_THRESHOLD,
  rewardForCollectIndex,
  utcDayKey,
} from './rewards.js';
import {
  withDb,
  getOrCreateUser,
  collectsForWalletOnDay,
  lastCollectForWallet,
  referredCount,
  totalReferralEarnings,
  totalCollectedByWallet,
  withdrawableBalance,
  setWithdrawalWallet,
  hasPendingWithdrawal,
  createPendingWithdrawal,
  markWithdrawalSent,
  markWithdrawalFailed,
} from './store.js';
import {
  issuePayload,
  verifyTonProof,
  issueSessionToken,
  verifySessionToken,
  APP_DOMAIN,
} from './auth.js';
import { verifyInitData } from './telegram.js';
import { verifyPublicKeyOwnsAddress } from './toncenter.js';
import { sendWithdrawal } from './wallet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const PORT = process.env.PORT || 8787;

// DEV_MODE lets requests through with a plain { wallet } body/query param, no
// signed proof required — that's how the demo frontend works out of the box.
// Set DEV_MODE=false once the frontend is wired to open inside Telegram (see
// telegram.js / POST /api/telegram/verify), so every collect requires a
// verified Telegram session.
const DEV_MODE = process.env.DEV_MODE !== 'false';

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // Demo-permissive CORS. Restrict to your real frontend origin in production.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB guard
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function isValidWallet(wallet) {
  // Loose shape check only. A wallet resolved this way (DEV_MODE fallback) is
  // NOT verified — see resolveWallet() below.
  return typeof wallet === 'string' && wallet.length >= 6 && wallet.length <= 128;
}

function bearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

/**
 * Resolves which wallet a request is acting as.
 *  - If a valid session token is present (issued after a verified TonConnect
 *    proof), that wallet is used and marked verified: true.
 *  - Otherwise, in DEV_MODE only, falls back to a raw `wallet` value from the
 *    request so the demo works without a real wallet connected. Marked
 *    verified: false so callers/UI can tell the difference.
 *  - Returns null if neither is available — the caller should respond 401.
 */
function resolveWallet(req, rawWallet) {
  const token = bearerToken(req);
  if (token) {
    const wallet = verifySessionToken(token);
    if (wallet) return { wallet, verified: true };
  }
  if (DEV_MODE && isValidWallet(rawWallet)) {
    return { wallet: rawWallet, verified: false };
  }
  return null;
}

function shapeStatus(db, wallet, verified) {
  const dayKey = utcDayKey();
  const user = getOrCreateUser(db, wallet);
  const todaysCollects = collectsForWalletOnDay(db, wallet, dayKey);
  const last = lastCollectForWallet(db, wallet);
  const collectsToday = todaysCollects.length;

  let secondsUntilNextCollect = 0;
  if (last) {
    const elapsed = (Date.now() - new Date(last.at).getTime()) / 1000;
    secondsUntilNextCollect = Math.max(0, Math.ceil(COOLDOWN_SECONDS - elapsed));
  }

  const balance = withdrawableBalance(db, wallet);

  return {
    wallet,
    verified,
    collectsToday,
    maxCollectsPerDay: MAX_COLLECTS_PER_DAY,
    maxDailySpend: MAX_DAILY_SPEND,
    nextCollectIndex: collectsToday + 1,
    nextRewardAmount: collectsToday < MAX_COLLECTS_PER_DAY ? rewardForCollectIndex(collectsToday + 1) : null,
    secondsUntilNextCollect,
    dailyLimitReached: collectsToday >= MAX_COLLECTS_PER_DAY,
    totalCollected: Number(totalCollectedByWallet(db, wallet).toFixed(6)),
    referralCode: user.referralCode,
    referredCount: referredCount(db, wallet),
    referralEarnings: totalReferralEarnings(db, wallet),
    // Bucket / withdrawal
    bucketBalance: balance,
    withdrawThreshold: WITHDRAW_THRESHOLD,
    bucketFraction: Math.min(1, balance / WITHDRAW_THRESHOLD),
    withdrawalWallet: user.withdrawalWallet,
    withdrawalWalletVerified: user.withdrawalWalletVerified || false,
    canWithdraw: balance >= WITHDRAW_THRESHOLD,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    // GET /api/ton-proof-payload — call this before connecting a wallet;
    // pass the returned payload into TonConnect's connectRequest.tonProof.
    if (req.method === 'GET' && url.pathname === '/api/ton-proof-payload') {
      return send(res, 200, { payload: issuePayload() });
    }

    // POST /api/ton-proof-verify  { address, publicKey, proof }
    // Verifies the wallet's signed proof and, on success, issues a session
    // token the frontend then sends as "Authorization: Bearer <token>".
    // Identifies the caller BY that TON wallet — use this if you want TON
    // wallet sign-in without Telegram. For a Telegram Mini App, prefer
    // /api/telegram/verify for identity and /api/wallet/link to attach a
    // payout wallet to that Telegram identity instead.
    if (req.method === 'POST' && url.pathname === '/api/ton-proof-verify') {
      const body = await readBody(req);
      const { address, publicKey, proof } = body;
      if (typeof address !== 'string' || typeof publicKey !== 'string' || !proof) {
        return send(res, 400, { error: 'invalid_request' });
      }
      const result = verifyTonProof({ address, publicKeyHex: publicKey, proof });
      if (!result.ok) return send(res, 401, result);
      const token = issueSessionToken(address);
      return send(res, 200, { token, wallet: address, verified: true });
    }

    // POST /api/telegram/verify  { initData }
    // Verifies Telegram's signed Mini App payload and issues a session token
    // for that Telegram user (identity key "tg:<telegramId>"). This is the
    // intended identity source for the Mini App — no wallet needed to collect.
    if (req.method === 'POST' && url.pathname === '/api/telegram/verify') {
      const body = await readBody(req);
      const result = verifyInitData(body.initData);
      if (!result.ok) return send(res, 401, result);
      const identity = `tg:${result.telegramId}`;
      const token = issueSessionToken(identity);
      return send(res, 200, {
        token,
        wallet: identity,
        verified: true,
        telegramId: result.telegramId,
        username: result.username,
      });
    }

    // POST /api/wallet/link  { address, publicKey, proof }  (Bearer token required)
    // Attaches a real TON wallet as the payout destination for the caller's
    // already-authenticated identity (typically a Telegram session). Requires
    // a fresh ton_proof for `address`, same as /api/ton-proof-verify, so this
    // doesn't just trust a bare address string — and additionally cross-checks
    // the signing public key against what's actually deployed on-chain for
    // that address (toncenter.js), so a validly-signed proof for the WRONG
    // key gets rejected outright rather than silently trusted.
    if (req.method === 'POST' && url.pathname === '/api/wallet/link') {
      const token = bearerToken(req);
      const identity = token ? verifySessionToken(token) : null;
      if (!identity) return send(res, 401, { error: 'unauthorized' });

      const body = await readBody(req);
      const { address, publicKey, proof } = body;
      if (typeof address !== 'string' || typeof publicKey !== 'string' || !proof) {
        return send(res, 400, { error: 'invalid_request' });
      }
      const result = verifyTonProof({ address, publicKeyHex: publicKey, proof });
      if (!result.ok) return send(res, 401, result);

      // true = confirmed on-chain, false = confirmed MISMATCH (reject), null = couldn't check
      // (new/undeployed wallet, or the indexer was unreachable) — allowed through but flagged.
      const onChainMatch = await verifyPublicKeyOwnsAddress(address, publicKey);
      if (onChainMatch === false) {
        return send(res, 401, { error: 'public_key_address_mismatch' });
      }

      await withDb((db) => setWithdrawalWallet(db, identity, address, onChainMatch === true));
      return send(res, 200, {
        linked: true,
        withdrawalWallet: address,
        onChainVerified: onChainMatch === true,
      });
    }

    // GET /api/status?wallet=...  (wallet param only honored in DEV_MODE — prefer Bearer token)
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const resolved = resolveWallet(req, url.searchParams.get('wallet'));
      if (!resolved) return send(res, 401, { error: 'unauthorized' });
      const status = await withDb((db) => shapeStatus(db, resolved.wallet, resolved.verified));
      return send(res, 200, status);
    }

    // POST /api/collect  { wallet }  (wallet param only honored in DEV_MODE — prefer Bearer token)
    if (req.method === 'POST' && url.pathname === '/api/collect') {
      const body = await readBody(req);
      const resolved = resolveWallet(req, body.wallet);
      if (!resolved) return send(res, 401, { error: 'unauthorized' });
      const wallet = resolved.wallet;

      const result = await withDb((db) => {
        const dayKey = utcDayKey();
        const user = getOrCreateUser(db, wallet);
        const todaysCollects = collectsForWalletOnDay(db, wallet, dayKey);

        if (todaysCollects.length >= MAX_COLLECTS_PER_DAY) {
          return { ok: false, status: 429, error: 'daily_limit_reached' };
        }

        const last = lastCollectForWallet(db, wallet);
        if (last) {
          const elapsed = (Date.now() - new Date(last.at).getTime()) / 1000;
          if (elapsed < COOLDOWN_SECONDS) {
            return {
              ok: false,
              status: 429,
              error: 'cooldown_active',
              secondsRemaining: Math.ceil(COOLDOWN_SECONDS - elapsed),
            };
          }
        }

        const index = todaysCollects.length + 1;
        const amount = rewardForCollectIndex(index);
        const collect = { wallet, index, amount, dayKey, at: new Date().toISOString() };
        db.collects.push(collect);

        // Credit referrer, if any, without touching their own daily cap.
        // Paid from a separate referral pool — not counted against this
        // wallet's own MAX_DAILY_SPEND.
        if (user.referredBy) {
          const refAmount = Number((amount * REFERRAL_SHARE).toFixed(6));
          db.referralEarnings.push({
            toWallet: user.referredBy,
            fromWallet: wallet,
            amount: refAmount,
            at: collect.at,
          });
        }

        return { ok: true, status: 200, collect, status_after: shapeStatus(db, wallet, resolved.verified) };
      });

      if (!result.ok) return send(res, result.status, result);
      return send(res, 200, { collect: result.collect, status: result.status_after });
    }

    // POST /api/withdraw  (Bearer token, or { wallet } in DEV_MODE)
    // Sends real GRAM from the hot wallet (wallet.js) to the caller's linked
    // withdrawal wallet. Split into three steps so the ~30s on-chain
    // confirmation wait doesn't hold the database lock the whole time:
    //   1. Reserve the withdrawal (fast, holds the DB lock briefly)
    //   2. Actually send it on-chain (slow, no DB lock held)
    //   3. Record the outcome (fast, holds the DB lock briefly)
    if (req.method === 'POST' && url.pathname === '/api/withdraw') {
      const body = await readBody(req);
      const resolved = resolveWallet(req, body.wallet);
      if (!resolved) return send(res, 401, { error: 'unauthorized' });
      const wallet = resolved.wallet;

      const reserved = await withDb((db) => {
        const user = getOrCreateUser(db, wallet);
        if (!user.withdrawalWallet) {
          return { ok: false, status: 400, error: 'no_withdrawal_wallet_linked' };
        }
        if (hasPendingWithdrawal(db, wallet)) {
          return { ok: false, status: 409, error: 'withdrawal_already_in_progress' };
        }
        const balance = withdrawableBalance(db, wallet);
        if (balance < WITHDRAW_THRESHOLD) {
          return { ok: false, status: 400, error: 'below_threshold', bucketBalance: balance, withdrawThreshold: WITHDRAW_THRESHOLD };
        }
        const record = createPendingWithdrawal(db, wallet, balance, user.withdrawalWallet);
        return { ok: true, id: record.id, amount: balance, to: user.withdrawalWallet };
      });

      if (!reserved.ok) return send(res, reserved.status, reserved);

      try {
        const { seqno } = await sendWithdrawal(reserved.to, reserved.amount);
        await withDb((db) => markWithdrawalSent(db, reserved.id, seqno));
        const status_after = await withDb((db) => shapeStatus(db, wallet, resolved.verified));
        return send(res, 200, {
          withdrawal: { amount: reserved.amount, to: reserved.to, seqno },
          status: status_after,
          note: 'Submitted on-chain from the hot wallet.',
        });
      } catch (err) {
        await withDb((db) => markWithdrawalFailed(db, reserved.id, err.message));
        return send(res, 502, { error: 'withdrawal_send_failed', message: err.message });
      }
    }

    // GET /api/ledger?limit=15  — recent collects across all wallets, for the live feed
    if (req.method === 'GET' && url.pathname === '/api/ledger') {
      const limit = Math.min(50, Number(url.searchParams.get('limit')) || 15);
      const rows = await withDb((db) =>
        [...db.collects]
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .slice(0, limit)
          .map((c) => ({ wallet: maskWallet(c.wallet), amount: c.amount, at: c.at }))
      );
      return send(res, 200, { collects: rows });
    }

    // POST /api/referral/link  { code, wallet }  (wallet param only honored in DEV_MODE — prefer Bearer token)
    if (req.method === 'POST' && url.pathname === '/api/referral/link') {
      const body = await readBody(req);
      const resolved = resolveWallet(req, body.wallet);
      const code = body.code;
      if (!resolved || typeof code !== 'string') {
        return send(res, resolved ? 400 : 401, { error: resolved ? 'invalid_request' : 'unauthorized' });
      }
      const wallet = resolved.wallet;
      const result = await withDb((db) => {
        const user = getOrCreateUser(db, wallet);
        if (user.referredBy) return { ok: false, error: 'already_linked' };
        const referrer = Object.values(db.users).find((u) => u.referralCode === code);
        if (!referrer) return { ok: false, error: 'code_not_found' };
        if (referrer.wallet === wallet) return { ok: false, error: 'cannot_refer_self' };
        user.referredBy = referrer.wallet;
        return { ok: true };
      });
      if (!result.ok) return send(res, 400, result);
      return send(res, 200, { linked: true });
    }

    // GET /tonconnect-manifest.json — required by TonConnect for wallet
    // linking. Generated per-request from the Host header instead of a
    // static file, so it's automatically correct on whatever domain this is
    // deployed to (Railway, Render, a custom domain) with no manual editing.
    // Explicitly no-cache: some wallets have been seen caching a manifest
    // fetched during an earlier failed connection attempt and replaying it
    // instead of re-fetching, which reproduces a stale domain_mismatch even
    // after the server-side config is fixed.
    if (req.method === 'GET' && url.pathname === '/tonconnect-manifest.json') {
      const host = req.headers.host || `localhost:${PORT}`;
      const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
      const origin = `${proto}://${host}`;
      const json = JSON.stringify({
        url: origin,
        name: 'Gram Drips',
        iconUrl: `${origin}/icon-512.png`,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(json);
    }

    // Static frontend — anything else GET-able falls through to /public,
    // so this one process serves both the Mini App page and the API.
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const served = await serveStatic(res, url.pathname);
      if (served) return;
    }

    send(res, 404, { error: 'not_found' });
  } catch (err) {
    send(res, 500, { error: 'server_error', message: err.message });
  }
});

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  // Collapse any ../ before joining, so requests can't escape PUBLIC_DIR.
  const safePath = normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;

  try {
    const data = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function maskWallet(wallet) {
  if (wallet.length <= 8) return wallet;
  return wallet.slice(0, 4) + '…' + wallet.slice(-4);
}

server.listen(PORT, () => {
  console.log(`Gram Drips API listening on http://localhost:${PORT}`);
});
