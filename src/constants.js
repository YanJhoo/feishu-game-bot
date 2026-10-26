'use strict';

const PHASES = Object.freeze({
  WAITING: 'waiting',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  FINISHED: 'finished',
  DISBANDED: 'disbanded',
});

const MAX_PLAYERS = 9;

module.exports = { PHASES, MAX_PLAYERS };
