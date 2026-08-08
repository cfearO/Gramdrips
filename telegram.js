import crypto from 'crypto';

// Set this from @BotFather → your bot → API Token. Treat it like a password.
const BOT_TOKEN = process.env.BOT_TOKEN || '';

// Telegram recommends rejecting stale initData; a Mini App session shouldn't
// be signing in with data from days ago.
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

/**
 * Verifies the initData string Telegram injects into a Mini App via
 * window.Telegram.WebApp.initData. Confirms it was actually signed by
 * Telegram for your bot (HMAC-SHA256 per Telegram's documented algorithm),
 * not forged by the client, and isn't stale.
 */
export function verifyInitData(initDataRaw) {
  if (!BOT_TOKEN) return { ok: false, error: 'bot_token_not_configured' };
  if (!initDataRaw || typeof initDataRaw !== 'string') return { ok: false, error: 'missing_init_data' };

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'missing_hash' };
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params) pairs.push(`${key}=${value}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  // secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  // hash = HMAC_SHA256(key=secret_key, data=data_check_string)
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(computedHash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad_signature' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > MAX_INIT_DATA_AGE_SECONDS) {
    return { ok: false, error: 'stale_init_data' };
  }

  let user;
  try {
    user = JSON.parse(params.get('user') || '{}');
  } catch {
    return { ok: false, error: 'bad_user_payload' };
  }
  if (!user.id) return { ok: false, error: 'missing_user_id' };

  return {
    ok: true,
    telegramId: user.id,
    username: user.username || null,
    firstName: user.first_name || null,
  };
}
