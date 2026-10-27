'use strict';

// Amounts are for a 1000-chip starting stack and scale with STARTING_STACK.
const BASE_AMOUNTS = Object.freeze([150, 300, 450, 600, 750, 900]);
// The player who still has the most chips keeps at least this lead (per 1000 starting chips).
const BASE_LEADER_RESERVE = 200;

const DEFAULT_PHRASES = Object.freeze([
  '我是菜鸟，这把确实没打明白',
  '我只会瞎跟，根本不会算牌',
  '好牌被我打烂了，申请补点学费',
  '我刚才打得太上头了，请允许我再抢救一下',
  '我是本桌又菜又爱送的散财童子，求一次翻身机会',
  '我已当众证明自己牌技稀烂，求各位高手赏我一次复仇机会',
]);

// BAILOUT_PHRASES lets a group use its own six phrases, separated by “|”.
function configuredPhrases(environment = process.env) {
  const custom = String(environment.BAILOUT_PHRASES || '').split('|').map((phrase) => phrase.trim()).filter(Boolean);
  if (custom.length === 0) return DEFAULT_PHRASES;
  if (custom.length !== DEFAULT_PHRASES.length || new Set(custom).size !== custom.length) {
    console.warn(`BAILOUT_PHRASES 需要 ${DEFAULT_PHRASES.length} 句互不相同的口令（用 | 分隔），已改用默认口令。`);
    return DEFAULT_PHRASES;
  }
  return custom;
}

function scaled(amount, startingStack) {
  const stack = Number.isSafeInteger(startingStack) && startingStack > 0 ? startingStack : 1000;
  return Math.max(1, Math.round((amount * stack) / 1000));
}

function bailoutTiers(startingStack = 1000, environment = process.env) {
  return configuredPhrases(environment).map((phrase, index) => ({
    level: index + 1,
    amount: scaled(BASE_AMOUNTS[index], startingStack),
    phrase,
  }));
}

function leaderReserve(startingStack = 1000) {
  return scaled(BASE_LEADER_RESERVE, startingStack);
}

// Default tiers for a 1000-chip table, kept for existing imports.
const BAILOUT_TIERS = Object.freeze(bailoutTiers(1000, {}).map((tier) => Object.freeze(tier)));

function bailoutTierForPhrase(text, environment = process.env) {
  return bailoutTiers(1000, environment).find((tier) => tier.phrase === text) || null;
}

module.exports = { BAILOUT_TIERS, DEFAULT_PHRASES, bailoutTiers, leaderReserve, bailoutTierForPhrase };
