'use strict';

const crypto = require('node:crypto');

const SUITS = Object.freeze([
  { code: 'S', symbol: '♠' },
  { code: 'H', symbol: '♥' },
  { code: 'D', symbol: '♦' },
  { code: 'C', symbol: '♣' },
]);

const RANKS = Object.freeze([
  ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
  ['8', 8], ['9', 9], ['10', 10], ['J', 11], ['Q', 12], ['K', 13], ['A', 14],
]);

function createDeck() {
  return SUITS.flatMap((suit) => RANKS.map(([label, rank]) => ({
    id: `${rank}${suit.code}`,
    rank,
    label,
    suit: suit.code,
    symbol: suit.symbol,
  })));
}

// Fisher-Yates with cryptographically secure, unbiased random indexes.
function shuffle(deck) {
  const result = deck.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function secureRandomIndex(length) {
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('随机范围必须是正整数');
  return crypto.randomInt(length);
}

function formatCard(card) {
  return `${card.symbol}${card.label}`;
}

function formatCards(cards) {
  return cards.map(formatCard).join(' ');
}

const PLAYING_CARD_BASE = Object.freeze({ S: 0x1F0A0, H: 0x1F0B0, D: 0x1F0C0, C: 0x1F0D0 });
const PLAYING_CARD_RANK = Object.freeze({ 14: 1, 11: 11, 12: 13, 13: 14 });

function playingCardGlyph(card) {
  const rankCode = PLAYING_CARD_RANK[card.rank] || card.rank;
  return String.fromCodePoint(PLAYING_CARD_BASE[card.suit] + rankCode);
}

function formatCardsVisual(cards) {
  if (!cards || cards.length === 0) return '等待发牌';
  const coloredSuit = { S: '♠️', H: '♥️', D: '♦️', C: '♣️' };
  return cards.map((card) => `${playingCardGlyph(card)} ${coloredSuit[card.suit] || card.symbol}${card.label}`).join('　');
}

module.exports = { createDeck, shuffle, secureRandomIndex, formatCard, formatCards, playingCardGlyph, formatCardsVisual };
