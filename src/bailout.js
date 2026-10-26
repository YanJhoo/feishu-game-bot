'use strict';

const BAILOUT_TIERS = Object.freeze([
  { level: 1, amount: 150, phrase: '我是菜猪，这把确实没打明白' },
  { level: 2, amount: 300, phrase: '我是只会瞎跟的笨猪，根本不会算牌' },
  { level: 3, amount: 450, phrase: '我是把好牌打烂的蠢货，申请补点学费' },
  { level: 4, amount: 600, phrase: '我承认刚才打得像个傻逼，请允许我再抢救一下' },
  { level: 5, amount: 750, phrase: '我是本桌又菜又上头的送财傻逼，求一次翻身机会' },
  { level: 6, amount: 900, phrase: '我已当众证明自己是牌技稀烂的超级蠢猪傻逼，求各位高手赏我一次复仇机会' },
]);

function bailoutTierForPhrase(text) {
  return BAILOUT_TIERS.find((tier) => tier.phrase === text) || null;
}

module.exports = { BAILOUT_TIERS, bailoutTierForPhrase };
