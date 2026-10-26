'use strict';

const HAND_NAMES = Object.freeze([
  '高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺',
]);

function combinations(cards, size) {
  const result = [];
  const selected = [];
  function visit(start) {
    if (selected.length === size) {
      result.push(selected.slice());
      return;
    }
    for (let i = start; i <= cards.length - (size - selected.length); i += 1) {
      selected.push(cards[i]);
      visit(i + 1);
      selected.pop();
    }
  }
  visit(0);
  return result;
}

function straightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.length !== 5) return 0;
  if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) return 5;
  return unique[0] - unique[4] === 4 ? unique[0] : 0;
}

// A score is lexicographically comparable: category then all relevant kickers.
function scoreFive(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) throw new Error('必须恰好评估 5 张牌');
  const ranks = cards.map((card) => card.rank);
  const countByRank = new Map();
  ranks.forEach((rank) => countByRank.set(rank, (countByRank.get(rank) || 0) + 1));
  const groups = [...countByRank.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const straight = straightHigh(ranks);
  const descending = [...new Set(ranks)].sort((a, b) => b - a);

  if (flush && straight) return [8, straight];
  if (groups[0].count === 4) return [7, groups[0].rank, groups[1].rank];
  if (groups[0].count === 3 && groups[1].count === 2) return [6, groups[0].rank, groups[1].rank];
  if (flush) return [5, ...descending];
  if (straight) return [4, straight];
  if (groups[0].count === 3) return [3, groups[0].rank, ...groups.slice(1).map((group) => group.rank)];
  if (groups[0].count === 2 && groups[1].count === 2) return [2, groups[0].rank, groups[1].rank, groups[2].rank];
  if (groups[0].count === 2) return [1, groups[0].rank, ...groups.slice(1).map((group) => group.rank)];
  return [0, ...descending];
}

function compareScores(left, right) {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function bestHand(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
    throw new Error('德州牌型评估需要 5 至 7 张牌');
  }
  let best = null;
  for (const fiveCards of combinations(cards, 5)) {
    const score = scoreFive(fiveCards);
    if (!best || compareScores(score, best.score) > 0) {
      best = { cards: fiveCards, score, name: HAND_NAMES[score[0]] };
    }
  }
  return best;
}

module.exports = { HAND_NAMES, combinations, scoreFive, compareScores, bestHand };
