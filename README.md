# Gram Drips — backend + frontend

Zero-dependency Node service. No `npm install` needed — just Node 18+.
`server.js` runs the API *and* serves the frontend (`public/index.html`) from
the same process, so the whole thing is one deployable unit.

## Run it locally

```
cd backend
npm start        # or: node server.js
```

Open `http://localhost:8787` — that's the Mini App page, served by the same
process as the API. There's nothing else to point at each other; the
frontend calls `/api/...` relative to whatever origin it's loaded from.

## Identity: Telegram, not wallet-first

Collecting doesn't require a wallet at all. When this page opens inside
Telegram, `telegram-web-app.js` (loaded in `<head>`) gives it a signed
`initData` payload identifying the Telegram user; the frontend sends that to
the backend once on load:

1. `POST /api/telegram/verify { initData }` — verifies Telegram's HMAC
   signature (`backend/telegram.js`, using only Node's built-in `crypto`),
   checks it isn't stale, and on success issues a session token for identity
   `tg:<telegramId>`.
2. That token is sent as `Authorization: Bearer <token>` on every subsequent
   request. `/api/collect`, `/api/status`, `/api/withdraw`, and
   `/api/referral/link` all derive *who's asking* from this token — never
   from a client-supplied wallet string, once a token is present.

Set `BOT_TOKEN` (from @BotFather → your bot → API Token) as an environment
variable — without it, `/api/telegram/verify` always fails.

**DEV_MODE** (default on): with no valid session token, the server falls
back to trusting a plain `wallet` field in the request — how the page
behaves when opened in a normal browser instead of Telegram (`isVerified:
false` on every response made this way). Set `DEV_MODE=false` once you've
tested the real Telegram flow, so every request needs a verified session.

## Payout wallet: separate from identity

Telegram tells the backend *who* you are; it says nothing about *where to
send GRAM*. That's a second, optional step — linking a real TON wallet via
TonConnect, only needed once someone's ready to withdraw:

1. `GET /api/ton-proof-payload` — one-time nonce for the wallet to sign.
2. Wallet signs a proof over that nonce + your domain + a timestamp.
3. `POST /api/wallet/link { address, publicKey, proof }` *(Bearer token
   required)* — verifies the Ed25519 signature (`backend/auth.js`), and on
   success attaches `address` as the withdrawal destination for the caller's
   already-authenticated identity.

`/api/withdraw` checks for a linked wallet before checking the balance —
`400 no_withdrawal_wallet_linked` if none is set yet.

There's also `POST /api/ton-proof-verify`, which does the same signature
check but *creates a session* keyed to the wallet address itself, for pure
TON-wallet sign-in without Telegram (e.g. testing outside a Mini App).

**On-chain verification:** `verifyTonProof()` in `auth.js` proves the caller
holds the private key for a given public key — it doesn't, by itself, prove
that public key is the one actually deployed on-chain for the claimed
address. `toncenter.js` closes that gap: `verifyPublicKeyOwnsAddress()` calls
TonCenter's `getWalletInformation` (its officially recommended endpoint for
this) and compares the on-chain public key against the one used to sign the
proof. `/api/wallet/link` uses the result as policy:

- **Match** → linked, `onChainVerified: true`.
- **Mismatch** → rejected with `401 public_key_address_mismatch`. This is a
  real spoof signal: a validly-signed proof for a public key that isn't the
  one actually controlling the address.
- **Inconclusive** (wallet never deployed/funded on-chain yet, or the
  indexer is unreachable) → still linked, but `onChainVerified: false`. New
  wallets legitimately can't be checked this way — TonCenter can only read a
  public key for a contract that's actually been deployed. Tightening this
  (reject instead of flag) is a one-line change in `server.js` if you'd
  rather block payouts to unverified wallets outright.

Set `TONCENTER_API_KEY` (free from @tonapibot on Telegram) — without one,
TonCenter rate-limits to 1 request/second, fine for testing, not for real
traffic. `TONCENTER_BASE` defaults to mainnet; point it at
`https://testnet.toncenter.com/api/v2` for testnet.

I tested `toncenter.js`'s parsing logic against TonCenter's documented
response shapes (active wallet with matching/mismatched key, uninitialized
wallet, indexer error) and the actual outgoing request (URL, API key header,
timeout) — but not against the live API itself, since this environment has
no network access. The request is written to their published docs, not
guessed at, but worth confirming against a real response the first time you
link a wallet for real.

**On the frontend:** `connectWallet()` in `public/index.html` is wired to a
real `@tonconnect/ui` integration (loaded via unpkg, since it's not on
cdnjs) — clicking "Link payout wallet" opens TonConnect's modal, requests a
`ton_proof` using a nonce from the backend, and on a successful connection
calls `/api/wallet/link` with the signed proof. Every piece that runs
server-side (nonce issuance, Ed25519 verification, on-chain cross-check,
session tokens) has been tested end-to-end with a real generated keypair and
a mocked indexer; the actual browser round trip through a wallet app hasn't
been, since that needs a live wallet to click through and this environment
has neither network access nor a wallet app. If something in that round
trip doesn't line up once you test it for real, the browser console will
point at what to fix — the failure modes are narrow (wrong manifest fields,
a mismatched `APP_DOMAIN`, or a wallet that doesn't support `ton_proof`).

`GET /tonconnect-manifest.json` is generated per-request from the `Host`
header rather than a static file, so it's automatically correct on whatever
domain this ends up deployed to — nothing to edit after deploying. The icon
it points to (`public/icon-512.png`) is a placeholder droplet mark; swap it
for real branding whenever you like.

## Setting up the Telegram Mini App

1. Message **@BotFather**, `/newbot` if you don't have one yet — note the
   bot token it gives you, that's `BOT_TOKEN`.
2. `/newapp` — register the Mini App. It'll ask for a name, description,
   icon, and a **public HTTPS URL** (your Railway/Render URL, see below;
   `localhost` won't work here).
3. Set `APP_DOMAIN` to that same host (no `https://`, e.g.
   `gram-drips.up.railway.app`) — it must exactly match what wallets see as
   the `domain` when signing a `ton_proof`, so payout-wallet linking matches.

## Economics (backend/rewards.js)

Grounded in real AdsGram rewarded-video revenue, not an arbitrary target —
**GRAM here is the real on-chain coin** (Toncoin was renamed to Gram in June
2026, currently ~$1.40).

- `MAX_COLLECTS_PER_DAY = 20`
- `COOLDOWN_SECONDS = 15 * 60` — 15 minutes between collects
- `AD_CPM_LOWEST_TIER = 0.5` — AdsGram's published lowest CPM tier, in GRAM per 1,000 rewarded views
- `AD_REVENUE_PER_VIEW = 0.0005` GRAM — what one ad view earns you at that tier
- `USER_SHARE = 0.5` — you keep the other half as margin
- `REWARD_PER_COLLECT = 0.00025` GRAM — **flat**, not escalating: every collect needs
  one ad view of roughly equal value, so there's no economic reason for later
  collects in a day to pay more
- `MAX_DAILY_SPEND = 0.005` GRAM/day (20 × 0.00025) ≈ **$0.007/day** per active user at today's price
- `REFERRAL_SHARE = 0.10` — referrer earns 10% of every collect their invitee makes,
  paid from a separate referral pool, not counted against `MAX_DAILY_SPEND`
- `WITHDRAW_THRESHOLD = 0.05` GRAM — reachable in ~10 days of full daily
  collecting; keeps the ~0.0055 GRAM TON network fee (absorbed from your
  margin, not deducted from the user) to a reasonable share of the payout

This is pegged to AdsGram's *lowest* tier on purpose — if a user's actual geo
pays a higher CPM, your margin grows instead of shrinking. If you later want
to pay out a live share of the *actual* CPM AdsGram reports for that
impression, that needs their SDK's reward-callback payload wired into
`/api/collect` — a reasonable next step once you have a real AdsGram account.

## Endpoints

- `POST /api/telegram/verify { initData }` — sign in as a Telegram user, get a session token
- `GET /api/ton-proof-payload` — get a nonce before signing a wallet proof
- `POST /api/wallet/link { address, publicKey, proof }` *(Bearer token required)* — attach a payout wallet to the caller's identity
- `POST /api/ton-proof-verify { address, publicKey, proof }` — alternative: sign in *as* a TON wallet directly (no Telegram)
- `GET /api/status` *(Bearer token, or `?wallet=` in DEV_MODE)* — collects today, bucket balance, withdraw threshold, linked payout wallet, referral stats
- `POST /api/collect` *(Bearer token, or `{ wallet }` in DEV_MODE)* — collects a drip; `429` with `cooldown_active` or `daily_limit_reached` if blocked
- `POST /api/withdraw` *(Bearer token, or `{ wallet }` in DEV_MODE)* — sends real GRAM from the hot wallet, see "Setting up real withdrawals" below. `400 no_withdrawal_wallet_linked`, `400 below_threshold`, `409 withdrawal_already_in_progress`, or `502 withdrawal_send_failed` depending on what went wrong
- `GET /api/ledger?limit=15` — recent collects across all wallets, wallet addresses masked (no auth, read-only)
- `POST /api/referral/link { code }` *(Bearer token, or `{ wallet, code }` in DEV_MODE)* — links the caller to a referrer's code, once

**Naming:** the project is called **Gram Drips**, and both the API and the
copy use "collect" rather than "claim" — deliberately, since "claim GRAM" is
the exact phrase the TON Foundation is warning people about as a scam
pattern following the June 2026 Toncoin→Gram rebrand.

## Deploying to Railway or Render

Either works — same repo, same start command (`node server.js`), no build
step. Configs for both are included (`railway.json`, `render.yaml`) so
either platform's auto-detection has what it needs.

**Railway:**
1. New Project → Deploy from GitHub repo → pick this repo, root at `backend/`
   if your repo has other folders alongside it.
2. Set env vars: `BOT_TOKEN`, `APP_DOMAIN` (fill in after step 3), `SESSION_SECRET`
   (any long random string), `DEV_MODE=false` once you've tested the real flow.
3. Railway gives you a `*.up.railway.app` URL — that's your `APP_DOMAIN` and
   your BotFather Mini App URL.
4. **Persistent storage:** by default `data/db.json` lives in the container's
   ephemeral filesystem and resets on every redeploy. Add a **Railway
   Volume**, mount it at e.g. `/data`, and set `DATA_DIR=/data` so balances
   survive redeploys.

**Render:**
1. New → Blueprint → point at this repo; `render.yaml` sets it up as a free
   web service automatically.
2. Fill in `BOT_TOKEN` and `APP_DOMAIN` (your `*.onrender.com` URL) in the
   dashboard — `render.yaml` marks them `sync: false` so it'll prompt you.
3. **Persistent storage:** Render's free tier has no persistent disk at all —
   `data/db.json` resets on every restart, not just redeploys, including the
   automatic spin-down after inactivity. A persistent disk needs a paid
   instance type; without one, treat this tier as demo-only.

Either way, **don't rely on the JSON file for real user balances** long
term — see "Before this touches real money" below.

## Setting up real withdrawals

`/api/withdraw` sends actual GRAM now, via a dedicated "hot wallet" whose
mnemonic lives server-side (`wallet.js`, using `@ton/ton` — this is the one
place in the project that needs a real npm dependency, since correctly
building and signing a TON wallet transaction requires proper cell/BOC
serialization, not something worth hand-rolling for something that moves
real money).

1. **Create a wallet dedicated to this app** — Tonkeeper, "Add wallet" →
   "Create new wallet". Do not reuse your personal wallet; if this server is
   ever compromised, only the hot wallet's balance is at risk, not everything
   you own. Save the 24-word phrase.
2. **Set `HOT_WALLET_MNEMONIC`** in Railway/Render to that 24-word phrase,
   space-separated, as a single env var value.
3. **Fund it** — enough to cover the withdrawals you expect between top-ups,
   plus network fees (~0.005 GRAM per send). Keep the balance modest and top
   up periodically rather than parking a large reserve in it — standard hot
   wallet practice, and it limits your exposure if anything goes wrong.
4. **Test on testnet first.** Set `TON_NETWORK=testnet`, get free testnet
   GRAM from a testnet faucet (search "TON testnet faucet"), and run a real
   withdrawal through the whole flow before ever pointing this at mainnet
   funds. I could not personally test a live broadcast from this environment
   (no network access here) — the `@ton/ton` API used in `wallet.js` is
   confirmed against the library's own README and TON's official docs, not
   guessed at, but the *first* real send should still be a small, watched
   test, not a leap of faith.
5. Once you're confident, unset `TON_NETWORK` (or set it to `mainnet`) and
   fund the wallet with real GRAM.

**How a withdrawal actually works:** `/api/withdraw` reserves the amount
first (marks it `pending`, which immediately zeroes the bucket and blocks a
second withdrawal from starting concurrently), *then* signs and submits the
on-chain transfer. If the send throws, the withdrawal is marked `failed` and
the balance is restored so the user can retry — nothing is silently lost
either way. I tested this whole state machine (reserve → success, reserve →
failure → balance restored → retry succeeds, two concurrent requests → only
one wins) against a mocked hot wallet; what's untested is the real broadcast
itself, per the testnet note above.

`sendWithdrawal()` in `wallet.js` reports success once the transaction is
*submitted* without error — it doesn't wait around to confirm the
transaction actually landed on-chain. That's a deliberate simplification:
for most purposes "submitted without an error" is enough signal to treat a
withdrawal as sent, and TON blocks are fast enough that lengthy confirmation
polling mostly just makes users wait. If you want stronger guarantees before
telling someone their withdrawal is done, poll `contract.getSeqno()` after
sending until it advances past the seqno you used.

## Before this touches real money

- **Test a real withdrawal on testnet** before trusting this with mainnet
  funds — see "Setting up real withdrawals" above.
- **Decide the inconclusive-link policy** — right now an unverifiable wallet
  (new/undeployed, or indexer down) is linked anyway with `onChainVerified:
  false`. Confirm that's the behavior you want before real payouts start;
  flipping it to reject instead is a one-line change (see "On-chain
  verification" above).
- **Attach a real persistent volume** (Railway) or a paid persistent disk
  (Render), or better, **move off the JSON file entirely** to Postgres —
  both platforms offer a managed instance a click away. The in-process write
  queue in `store.js` doesn't hold up across multiple server instances
  either, so this matters more the more traffic you get. This is more
  important than ever now that `data/db.json` is what stands between a
  withdrawal being correctly marked 'sent' and it silently resetting on a
  redeploy while the hot wallet has already paid out.
- **Rate-limit by IP** in addition to the per-identity cooldown, so one IP
  can't farm many Telegram accounts.
- **Restrict CORS** (`Access-Control-Allow-Origin` in `server.js`) to your
  actual Mini App origin instead of `*`.
- **Monitor the hot wallet balance** and alert/top up before it runs dry — a
  withdrawal failing because the hot wallet is empty is a bad experience,
  even though the balance-restore-on-failure logic means it's not a lost
  funds situation.
