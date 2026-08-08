// Shared faucet economics, grounded in real ad revenue rather than an
// arbitrary target. GRAM here is the real on-chain coin (formerly Toncoin,
// renamed June 2026) — these numbers pay out actual value, so keep them
// conservative and update them if your live AdsGram CPM changes.

export const MAX_COLLECTS_PER_DAY = 20;
export const COOLDOWN_SECONDS = 15 * 60; // 15 minutes between claims

// --- Ad revenue basis -------------------------------------------------
// AdsGram's published lowest tier: 0.5 GRAM per 1,000 rewarded-video views.
// This is developer payout CPM (already net of AdsGram's own cut), so it's
// the real revenue one claim's ad view generates.
export const AD_CPM_LOWEST_TIER = 0.5;          // GRAM per 1,000 views, worst-case geo
export const AD_REVENUE_PER_VIEW = AD_CPM_LOWEST_TIER / 1000; // 0.0005 GRAM

// --- Margin ------------------------------------------------------------
// Keep half of every claim's ad revenue as margin; the rest funds the reward.
// Because this is pegged to the *lowest* CPM tier, higher-paying geos widen
// your margin further rather than shrinking it — the safe direction to be wrong.
export const USER_SHARE = 0.5;

// --- Reward per claim ----------------------------------------------------
// Flat, not escalating: every claim requires one ad view of equal value, so
// there's no economic reason for later claims to pay more. (The old
// escalating curve was tuned to an arbitrary 0.055 GRAM/day target, not to
// what the ads actually earn — replaced now that GRAM is the real coin.)
export const REWARD_PER_COLLECT = Number((AD_REVENUE_PER_VIEW * USER_SHARE).toFixed(6)); // 0.00025 GRAM
export const MAX_DAILY_SPEND = Number((REWARD_PER_COLLECT * MAX_COLLECTS_PER_DAY).toFixed(6)); // 0.005 GRAM/day

export const REFERRAL_SHARE = 0.10; // referrer earns 10% of each referred claim, paid from a separate referral pool — not counted against MAX_DAILY_SPEND above

// --- Withdrawal threshold ------------------------------------------------
// A simple TON/GRAM transfer costs roughly 0.0055 GRAM in network fees. Below
// that, sending a withdrawal loses money on gas alone. 0.05 GRAM keeps the
// fee to ~11% of the withdrawal (absorbed from your margin, not deducted from
// the user — see server.js /api/withdraw) while staying reachable in about
// 10 days of full daily collecting (200 claims at 0.00025 GRAM each).
export const NETWORK_FEE_ESTIMATE = 0.0055; // GRAM, approximate — re-check against live TON fees before launch
export const WITHDRAW_THRESHOLD = 0.05;     // GRAM balance required before withdrawal unlocks

/**
 * Reward for the Nth claim of a given day (1-indexed). Flat by design — see
 * REWARD_PER_COLLECT above. Kept as a function (rather than inlining the
 * constant) so the escalating-curve shape can come back later without
 * touching every call site.
 */
export function rewardForCollectIndex(_index) {
  return REWARD_PER_COLLECT;
}

/**
 * UTC calendar-day key, e.g. "2026-08-06". Daily claim counts and the
 * MAX_COLLECTS_PER_DAY cap reset when this key changes.
 */
export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
