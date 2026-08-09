import crypto from 'crypto';

// Set these for your real deployment.
const APP_DOMAIN = process.env.APP_DOMAIN || 'localhost:8787';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const SESSION_TTL_SECONDS = 12 * 60 * 60; // how long a verified session stays valid
const PROOF_TTL_SECONDS = 15 * 60;        // how long a wallet has to sign+submit a payload

// One-time payloads issued to the frontend before connecting a wallet, consumed on verify.
// This is what stops someone replaying an old signed proof.
const issuedPayloads = new Map(); // payload -> expiresAt (ms)

export function issuePayload() {
  const payload = crypto.randomBytes(16).toString('hex');
  issuedPayloads.set(payload, Date.now() + PROOF_TTL_SECONDS * 1000);
  for (const [p, exp] of issuedPayloads) if (exp < Date.now()) issuedPayloads.delete(p);
  return payload;
}

function consumePayload(payload) {
  const exp = issuedPayloads.get(payload);
  if (!exp) return false;
  issuedPayloads.delete(payload); // single use
  return exp >= Date.now();
}

function parseAddress(rawAddress) {
  // TonConnect addresses arrive as "<workchain>:<hex account id>", e.g. "0:abcd...".
  const [wcStr, hashHex] = String(rawAddress).split(':');
  if (wcStr === undefined || !hashHex || hashHex.length !== 64) return null;
  return { workchain: parseInt(wcStr, 10), hash: Buffer.from(hashHex, 'hex') };
}

/**
 * Builds the exact byte message TonConnect wallets sign for ton_proof, per the
 * TonConnect ton_proof spec (protocol v2):
 *   sha256(0xffff ++ "ton-connect" ++ sha256("ton-proof-item-v2/" ++ workchain
 *          ++ address_hash ++ domain_len ++ domain ++ timestamp ++ payload))
 */
function buildProofMessage({ workchain, hash, domain, timestamp, payload }) {
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(workchain, 0);

  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(timestamp), 0);

  const domainBuf = Buffer.from(domain, 'utf8');
  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32LE(domainBuf.length, 0);

  const msg = Buffer.concat([
    Buffer.from('ton-proof-item-v2/', 'utf8'),
    wc,
    hash,
    domainLen,
    domainBuf,
    ts,
    Buffer.from(payload, 'utf8'),
  ]);
  const msgHash = crypto.createHash('sha256').update(msg).digest();

  const fullMsg = Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from('ton-connect', 'utf8'),
    msgHash,
  ]);
  return crypto.createHash('sha256').update(fullMsg).digest();
}

// Node's crypto wants Ed25519 public keys wrapped in a minimal SPKI DER envelope,
// not the raw 32 bytes TonConnect hands you.
function ed25519RawToSpki(rawPublicKey) {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, rawPublicKey]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verifies a TonConnect ton_proof. Confirms:
 *  - the payload was one we issued, unused, and not expired (anti-replay)
 *  - the proof's own timestamp is fresh
 *  - the domain matches this app
 *  - the signature is valid for the claimed public key
 *
 * NOTE — see verifyPublicKeyOwnsAddress() below. This function proves the
 * caller holds the private key for `publicKeyHex`; it does not by itself
 * prove `publicKeyHex` is the key controlling `address` on-chain. Call
 * verifyPublicKeyOwnsAddress() as well before fully trusting `address`.
 */
export function verifyTonProof({ address, publicKeyHex, proof }) {
  if (!proof || typeof proof.payload !== 'string') return { ok: false, error: 'malformed_proof' };
  if (!consumePayload(proof.payload)) return { ok: false, error: 'payload_unknown_or_expired' };

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(proof.timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > PROOF_TTL_SECONDS) {
    return { ok: false, error: 'proof_expired' };
  }
  // TonConnect's proof.domain is an object { lengthBytes, value } per spec,
  // not a plain string — comparing the object directly to APP_DOMAIN would
  // never match regardless of whether the domain was actually correct.
  const domainValue = proof.domain && typeof proof.domain === 'object' ? proof.domain.value : proof.domain;
  if (domainValue !== APP_DOMAIN) return { ok: false, error: 'domain_mismatch' };

  const parsed = parseAddress(address);
  if (!parsed) return { ok: false, error: 'bad_address' };

  let publicKey, signature;
  try {
    publicKey = ed25519RawToSpki(Buffer.from(publicKeyHex, 'hex'));
    signature = Buffer.from(proof.signature, 'base64');
  } catch {
    return { ok: false, error: 'bad_key_or_signature_encoding' };
  }

  const message = buildProofMessage({
    workchain: parsed.workchain,
    hash: parsed.hash,
    domain: domainValue,
    timestamp: proof.timestamp,
    payload: proof.payload,
  });

  let validSignature = false;
  try {
    validSignature = crypto.verify(null, message, publicKey, signature);
  } catch {
    validSignature = false;
  }
  if (!validSignature) return { ok: false, error: 'bad_signature' };

  return { ok: true, address };
}

// NOTE: on-chain public-key verification (confirming the key that signed a
// ton_proof is actually the one deployed for that address) lives in
// toncenter.js, not here — it uses TonCenter's getWalletInformation
// endpoint, which is the officially recommended way to do this and returns
// the public key directly without needing to parse a raw get-method result.

export function issueSessionToken(wallet) {
  const payload = { wallet, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.wallet;
  } catch {
    return null;
  }
}

export { APP_DOMAIN };
