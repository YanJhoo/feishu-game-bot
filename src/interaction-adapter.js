'use strict';

// Card callbacks can be translated into the exact same command object used by
// text messages. This keeps future interactive cards outside the poker rules.
function cardActionToCommand(action) {
  const fallbackType = action?.name === 'anonymous_speech_submit' ? 'GAME_SPEAK_SUBMIT' : '';
  const type = String(action?.value?.action || fallbackType).toUpperCase();
  const map = {
    OPEN: { type: 'OPEN' },
    SELECT_GAME: { type: 'SELECT_GAME' },
    CHECK: { type: 'CHECK' },
    CALL: { type: 'CALL' },
    FOLD: { type: 'FOLD' },
    ALL_IN: { type: 'ALL_IN' },
    VIEW: { type: 'VIEW' },
    SHOW_HOLE: { type: 'SHOW_HOLE' },
    SHOW_BAILOUT: { type: 'SHOW_BAILOUT' },
    START: { type: 'START' },
    NEXT_HAND: { type: 'NEXT_HAND' },
    JOIN: { type: 'JOIN', name: null },
    LEAVE: { type: 'LEAVE' },
    RENAME: { type: 'RENAME' },
    TOGGLE_SIT_OUT: { type: 'TOGGLE_SIT_OUT' },
    DISBAND: { type: 'DISBAND' },
  };
  if (type === 'RAISE_TO') return { type, amount: Number(action.value.amount) };
  if (type === 'SELECT_GAME') return { type, game: String(action.value.game || '') };
  if (type === 'GAME_JOIN' || type === 'GAME_START' || type === 'GAME_LEAVE' || type === 'GAME_END') return { type: 'GAME_ACTION', action: type.slice(5) };
  if (type === 'GAME_SHOW_WORD') return { type: 'SHOW_GAME_WORD' };
  if (type === 'GAME_SCORE') return { type: 'GAME_ACTION', action: 'SCORE' };
  if (type === 'GAME_SPEAK_READY') return {
    type: 'GAME_ACTION',
    action: 'ARM_SPEECH',
    ...(action.value.turnVersion !== undefined ? { turnVersion: action.value.turnVersion } : {}),
  };
  if (type === 'GAME_SPEAK_SUBMIT') {
    const text = String(action?.formValue?.anonymous_speech ?? action?.form_value?.anonymous_speech ?? '').trim();
    return { type: 'GAME_ACTION', action: 'SPEAK', text };
  }
  if (type === 'GAME_ABSTAIN') return { type: 'GAME_ACTION', action: 'ABSTAIN' };
  if (type === 'GAME_VOTE') return { type: 'GAME_ACTION', action: 'VOTE_NAME', targetOpenId: String(action.value.targetOpenId || '') };
  if (type === 'BAILOUT_AUTO') return {
    type: 'BAILOUT',
    level: Number(action.value.level),
    handNumber: Number(action.value.handNumber),
  };
  if (type === 'RAISE_CUSTOM') {
    const rawAmount = action?.formValue?.raise_amount ?? action?.form_value?.raise_amount ?? action?.value?.amount;
    return { type: 'RAISE_TO', amount: Number(rawAmount) };
  }
  return map[type] || null;
}

module.exports = { cardActionToCommand };

