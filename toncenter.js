// Cross-checks that a public key which signed a valid ton_proof is actually
// the key deployed on-chain for that address. auth.js's verifyTonProof()
// only proves "this signature is valid for this public key" — it can't by
// itself prove the public key belongs to the address, especially since
// TonConnect lets a client report any address/publicKey pair alongside a
// signature. This module closes that gap using toncenter's indexer, which
// parses wallet contract state for us — no BOC/cell parsing needed here.

const TONCENTER_BASE = process.env.TONCENTER_BASE || 'https://toncenter.com/api/v2';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || ''; // optional but recommended — see README
const REQUEST_TIMEOUT_MS = 8000;

function normalizeHexKey(key) {
  if (typeof key !== 'string') return null;
  const stripped = key.startsWith('0x') || key.startsWith('0X') ? key.slice(2) : key;
  return stripped.toLowerCase().replace(/^0+/, '') || '0';
}

/**
 * Returns:
 *   true  — the public key IS the one deployed on-chain for this address. Confirmed.
 *   false — the public key does NOT match what's on-chain. Reject the link;
 *           this means a validly-signed proof was presented for the wrong key.
 *   null  — couldn't determine either way (wallet not yet deployed on-chain,
 *           indexer unreachable, or an unrecognized contract type). Common
 *           and expected for brand-new wallets — the caller should decide
 *           whether to allow linking anyway and flag it as unverified.
 */
export async function verifyPublicKeyOwnsAddress(address, publicKeyHex) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${TONCENTER_BASE}/getWalletInformation?address=${encodeURIComponent(address)}`;
    const headers = TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {};
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.ok || !data.result) return null;

    const { account_state, public_key } = data.result;
    if (account_state === 'uninitialized' || !public_key) {
      // Nothing deployed yet to check against — not an error, just unknown.
      return null;
    }

    const onChain = normalizeHexKey(public_key);
    const claimed = normalizeHexKey(publicKeyHex);
    if (!onChain || !claimed) return null;

    return onChain === claimed;
  } catch {
    return null; // network error, timeout, bad JSON — treat as "couldn't check"
  } finally {
    clearTimeout(timeout);
  }
}
