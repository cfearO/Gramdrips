// Signs and broadcasts real GRAM (TON) withdrawals from the app's own
// funded "hot wallet" — a dedicated wallet whose mnemonic lives server-side
// as a secret, separate from any user's wallet. This is what actually pays
// out withdrawals and covers their network fees.
//
// Uses @ton/ton + @ton/crypto rather than hand-rolled cell/BOC serialization
// (unlike auth.js's Ed25519 work, which only needed Node's built-in crypto).
// Constructing a valid wallet-contract transfer message correctly by hand is
// a much larger, easier-to-get-subtly-wrong undertaking than verifying a
// signature — this is exactly the kind of thing to use the real library for
// rather than reimplement, given real funds are at stake.
//
// IMPORTANT: I have not been able to test an actual broadcast against the
// live TON network from this environment (no network access here). The API
// used below is confirmed against @ton/ton's own README and TON's official
// docs as of writing, not guessed at — but the very first real send should
// be a small amount on testnet, watched closely, before trusting this with
// meaningful mainnet funds. See README "Setting up real withdrawals".

import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { toNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

const TONCENTER_JSONRPC_URL =
  process.env.TONCENTER_JSONRPC_URL ||
  (process.env.TON_NETWORK === 'testnet'
    ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
    : 'https://toncenter.com/api/v2/jsonRPC');

let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;
  cachedClient = new TonClient({
    endpoint: TONCENTER_JSONRPC_URL,
    apiKey: process.env.TONCENTER_API_KEY || undefined,
  });
  return cachedClient;
}

let cachedHotWallet = null;
async function getHotWallet() {
  if (cachedHotWallet) return cachedHotWallet;

  const raw = (process.env.HOT_WALLET_MNEMONIC || '').trim();
  if (!raw) {
    throw new Error(
      'HOT_WALLET_MNEMONIC is not set. Generate a fresh 24-word wallet dedicated to this app — do not reuse a personal wallet — and set its mnemonic as this env var. See README.'
    );
  }
  const words = raw.split(/\s+/);
  if (words.length !== 24) {
    throw new Error(`HOT_WALLET_MNEMONIC must be exactly 24 words, got ${words.length}.`);
  }

  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const contract = getClient().open(wallet);

  cachedHotWallet = { contract, keyPair, address: wallet.address };
  return cachedHotWallet;
}

export async function getHotWalletStatus() {
  const { contract, address } = await getHotWallet();
  const [balance, seqno] = await Promise.all([contract.getBalance(), contract.getSeqno()]);
  return {
    address: address.toString(),
    balanceNano: balance.toString(),
    balanceGram: (Number(balance) / 1e9).toFixed(6),
    seqno,
  };
}

// The hot wallet has ONE sequential seqno shared across all withdrawals —
// two concurrent sends racing on the same seqno would corrupt one of them.
// This queue forces sends through one at a time, same pattern as store.js's
// withDb() for the same reason.
let sendQueue = Promise.resolve();
function withWalletQueue(fn) {
  const result = sendQueue.then(fn);
  sendQueue = result.catch(() => {});
  return result;
}

/**
 * Sends `amountGram` (a decimal string or number, e.g. 0.00025) of GRAM from
 * the hot wallet to `toAddress`. Signs and submits the transfer — does not
 * wait around for on-chain confirmation, just that the wallet accepted it
 * for broadcast. That's a real distinction: a submitted transaction can
 * still fail to land (bad seqno race, insufficient balance, network drops
 * it). For most purposes "submitted without an error" is good enough signal
 * to treat as sent; add confirmation polling back in if you want stronger
 * guarantees before telling the user their withdrawal is done.
 *
 * Throws on failure — callers should catch this and mark the withdrawal
 * 'failed' (see store.js) rather than silently losing track of it.
 */
export async function sendWithdrawal(toAddress, amountGram) {
  return withWalletQueue(() => sendWithdrawalUnqueued(toAddress, amountGram));
}

async function sendWithdrawalUnqueued(toAddress, amountGram) {
  const { contract, keyPair } = await getHotWallet();

  const seqno = await contract.getSeqno();
  const amountStr = typeof amountGram === 'number' ? amountGram.toFixed(9) : amountGram;

  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        to: toAddress,
        value: toNano(amountStr),
        bounce: false,
        body: 'Gram Drips withdrawal',
      }),
    ],
  });

  return { seqno };
}
