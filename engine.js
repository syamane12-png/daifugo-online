// 大富豪 ゲームエンジン(純粋なゲームロジックのみ)
// サーバー固有の処理(HTTP・ルーム管理など)は一切含みません。server.js から require して使います。
'use strict';

/* ============================================================
   ゲームエンジン本体
   ============================================================ */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const EFFECT_RANKS = ['5', '6', '7', '10', 'J']; // 8は別扱い(cutFlag)
const FOUL_PENALTY = 200;

function buildDeck() {
  const d = [];
  SUITS.forEach(s => RANKS.forEach(r => d.push({ suit: s, rank: r, id: s + r })));
  d.push({ suit: null, rank: 'JOKER', id: 'JOKER-A' });
  d.push({ suit: null, rank: 'JOKER', id: 'JOKER-B' });
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    const ai = a.rank === 'JOKER' ? 999 : RANKS.indexOf(a.rank);
    const bi = b.rank === 'JOKER' ? 999 : RANKS.indexOf(b.rank);
    if (ai !== bi) return ai - bi;
    return SUITS.indexOf(a.suit || '') - SUITS.indexOf(b.suit || '');
  });
}
function isRed(suit) { return suit === '♥' || suit === '♦'; }

function effectiveReversed(gs) { return (gs.revolutionCount % 2 === 1) !== gs.tempReversed; }
function currentStrength(gs, rank) {
  if (rank === 'JOKER') return 999;
  const idx = RANKS.indexOf(rank);
  return effectiveReversed(gs) ? (RANKS.length - 1 - idx) : idx;
}
function strengthWithReversal(rank, reversed) {
  if (rank === 'JOKER') return 999;
  const idx = RANKS.indexOf(rank);
  return reversed ? (RANKS.length - 1 - idx) : idx;
}
function nextStrongerRank(gs, rank) {
  const idx = RANKS.indexOf(rank);
  if (effectiveReversed(gs)) return idx > 0 ? RANKS[idx - 1] : null;
  return idx < RANKS.length - 1 ? RANKS[idx + 1] : null;
}
function activePlayers(gs) { return gs.players.filter(p => !p.finished); }
function nextActiveRaw(gs, i) {
  const n = gs.players.length; let j = i;
  do { j = (j + 1) % n; } while (gs.players[j].finished);
  return j;
}

function tryBuildStraightWithJokers(realCards, jokerCount) {
  if (realCards.length === 0) return null;
  const suit = realCards[0].suit;
  const realIdxs = [...new Set(realCards.map(c => RANKS.indexOf(c.rank)))].sort((a, b) => a - b);
  if (realIdxs.length !== realCards.length) return null;
  const total = realCards.length + jokerCount;
  if (total < 3) return null;
  const minReal = realIdxs[0], maxReal = realIdxs[realIdxs.length - 1];
  const lowerBound = Math.max(0, maxReal - total + 1);
  const upperBound = Math.min(minReal, RANKS.length - total);
  if (upperBound < lowerBound) return null;
  const start = upperBound, end = start + total - 1;
  const straightRanks = [];
  for (let i = start; i <= end; i++) straightRanks.push(RANKS[i]);
  return { suit, straightRanks };
}

function evaluateSelection(gs, playerIndex, cardIds) {
  const player = gs.players[playerIndex];
  const cards = player.hand.filter(c => cardIds.includes(c.id));
  if (cards.length === 0) return { ok: false };
  const jokers = cards.filter(c => c.rank === 'JOKER');
  const realCards = cards.filter(c => c.rank !== 'JOKER');
  let type, rank, suitsUsed, straightRanks = null;

  if (realCards.length === 0) {
    type = 'set'; rank = 'JOKER'; suitsUsed = [];
  } else {
    const realRanksArr = realCards.map(c => c.rank);
    const allSameRank = realRanksArr.every(r => r === realRanksArr[0]);
    if (allSameRank) {
      type = 'set'; rank = realRanksArr[0];
      suitsUsed = [...new Set(realCards.map(c => c.suit))];
    } else {
      const suits = realCards.map(c => c.suit);
      if (!suits.every(s => s === suits[0])) return { ok: false };
      const built = tryBuildStraightWithJokers(realCards, jokers.length);
      if (!built) return { ok: false };
      type = 'straight'; suitsUsed = [built.suit]; straightRanks = built.straightRanks;
      rank = straightRanks[straightRanks.length - 1];
    }
  }
  const count = cards.length;
  const isSpade3Counter = !!(gs.field && gs.field.count === 1 && gs.field.cards[0].rank === 'JOKER' &&
    count === 1 && cards[0].suit === '♠' && cards[0].rank === '3');
  const isAllJoker = realCards.length === 0;

  if (!isSpade3Counter) {
    if (gs.lockSeq) {
      const okJoker = isAllJoker;
      if (!okJoker && !(count === gs.lockSeq.count && rank === gs.lockSeq.rank && cards.every(c => c.suit && gs.lockSeq.suits.includes(c.suit)))) return { ok: false };
    } else if (gs.lockSuits) {
      if (!isAllJoker && !cards.every(c => c.suit ? gs.lockSuits.includes(c.suit) : true)) return { ok: false };
    }
    if (gs.field !== null) {
      if (gs.field.type !== type) return { ok: false };
      if (gs.field.count !== count) return { ok: false };
      if (currentStrength(gs, rank) <= currentStrength(gs, gs.field.rank)) return { ok: false };
    }
  }

  const wouldFinish = count === player.hand.length;
  if (wouldFinish) {
    const ranksInvolved = type === 'straight' ? straightRanks : [rank];
    const forbidden = isAllJoker || ranksInvolved.includes('2') ||
      (type === 'set' && rank === '8') ||
      (ranksInvolved.includes('3') && gs.revolutionCount % 2 === 1);
    if (forbidden) {
      if (gs.field === null && gs._leadCheckDepth === 0 && !anyLegalLeadExists(gs, playerIndex)) {
        // allow as last resort
      } else {
        return { ok: false, reason: 'forbidden_finish' };
      }
    }
  }
  return { ok: true, type, rank, count, cards, suitsUsed, straightRanks, isSpade3Counter };
}
function anyLegalLeadExists(gs, idx) {
  gs._leadCheckDepth = (gs._leadCheckDepth || 0) + 1;
  const player = gs.players[idx];
  const candidates = generateCandidates(player.hand);
  const result = candidates.some(arr => evaluateSelection(gs, idx, arr.map(c => c.id)).ok);
  gs._leadCheckDepth--;
  return result;
}
function describePlay(v) {
  if (v.type === 'straight') return `${v.suitsUsed[0]}${v.straightRanks.join('-')}の階段`;
  const label = v.rank === 'JOKER' ? 'JOKER' : v.rank;
  return v.count === 1 ? label : `${label}×${v.count}`;
}
function updateSuitChain(gs, v, reversedAtValidation) {
  let track = null;
  if (v.type === 'straight') track = { kind: 'straight', suits: [v.suitsUsed[0]], rank: v.rank, count: v.count };
  else if (v.type === 'set' && v.suitsUsed.length > 0) track = { kind: 'set', suits: v.suitsUsed.slice().sort(), rank: v.rank, count: v.count };
  if (track && gs.prevTrack && gs.prevTrack.kind === track.kind && gs.prevTrack.count === track.count &&
    gs.prevTrack.suits.join('') === track.suits.join('')) {
    const sequential = track.kind === 'set' &&
      strengthWithReversal(track.rank, reversedAtValidation) === strengthWithReversal(gs.prevTrack.rank, reversedAtValidation) + 1;
    const suitLabel = track.suits.join('');
    if (sequential) {
      const nextRank = nextStrongerRank(gs, track.rank);
      if (nextRank) {
        gs.lockSeq = { suits: track.suits, rank: nextRank, count: track.count };
        gs.lockSuits = track.suits.slice();
        const shape = track.count > 1 ? `の${track.count}枚組` : '';
        gs.log += `(激縛り発動!次は${suitLabel}${nextRank}${shape}かJOKERしか出せません)`;
      } else { gs.lockSuits = track.suits.slice(); gs.lockSeq = null; gs.log += `(マーク縛り発動!次は${suitLabel}のみ)`; }
    } else if (!gs.lockSeq) { gs.lockSuits = track.suits.slice(); gs.log += `(マーク縛り発動!次は${suitLabel}のみ)`; }
  }
  gs.prevTrack = track;
}

function clearFieldStateKeepScore(gs) {
  gs.field = null; gs.fieldOwner = null;
  gs.lockSuits = null; gs.lockSeq = null; gs.prevTrack = null;
  gs.passedThisField = new Set();
  gs.tempReversed = false;
  gs.trickHistory = [];
}

function advance(gs, fromIndex, { tobiSteps = 1 } = {}) {
  let i = fromIndex;
  for (let s = 0; s < tobiSteps; s++) i = nextActiveRaw(gs, i);
  const rawLanding = i;
  const owner = gs.fieldOwner;
  while (i !== owner && gs.passedThisField.has(i)) i = nextActiveRaw(gs, i);
  if (i === owner) {
    clearFieldStateKeepScore(gs);
    gs.currentIndex = owner;
  } else {
    gs.currentIndex = i;
  }
  gs.selected = [];
}

function checkGameEnd(gs) {
  const remaining = activePlayers(gs);
  if (remaining.length === 1) {
    const idx = gs.players.findIndex(p => !p.finished);
    gs.players[idx].finished = true;
    gs.finishOrder.push(idx);
    calculateRoundScore(gs);
    gs.phase = 'result';
    return true;
  }
  return false;
}
function calculateRoundScore(gs) {
  const n = gs.players.length;
  const winnerIdx = gs.finishOrder[0];
  const loserIdx = gs.finishOrder[n - 1];
  const loserHand = gs.players[loserIdx].hand.length;
  const multiplier = Math.pow(2, gs.revolutionCount);
  const points = loserHand * 100 * multiplier;
  gs.players[loserIdx].score -= points;
  gs.players[winnerIdx].score += points;
  gs.lastRoundPoints = points;
}
function commitFoulLoss(gs, actorIndex, reasonText) {
  gs.effectQueue = [];
  gs.pendingAfterQueue = null;
  const remaining = gs.players.filter((p, i) => i !== actorIndex && !p.finished);
  const rankedRemaining = remaining.slice().sort((a, b) => a.hand.length - b.hand.length);
  rankedRemaining.forEach(p => {
    const idx = gs.players.indexOf(p);
    p.finished = true; gs.finishOrder.push(idx);
  });
  gs.players[actorIndex].finished = true;
  gs.finishOrder.push(actorIndex);
  calculateRoundScore(gs);
  gs.players[actorIndex].score -= FOUL_PENALTY;
  gs.foulPenalty = { name: gs.players[actorIndex].name, amount: FOUL_PENALTY, reason: reasonText };
  gs.log = `⚠️ ${gs.players[actorIndex].name} が${reasonText}を実行できず反則負け!`;
  gs.phase = 'result';
}

function applyPlay(gs, playerIndex, cardIds) {
  const v = evaluateSelection(gs, playerIndex, cardIds);
  if (!v.ok) return false;
  const player = gs.players[playerIndex];
  const reversedAtValidation = effectiveReversed(gs);
  player.hand = player.hand.filter(c => !cardIds.includes(c.id));
  gs.field = { type: v.type, rank: v.rank, count: v.count, cards: v.cards, suitsUsed: v.suitsUsed };
  gs.fieldOwner = playerIndex;
  gs.selected = [];
  gs.trickHistory.push({
    type: v.type, rank: v.rank, count: v.count, cards: v.cards, suitsUsed: v.suitsUsed,
    straightRanks: v.straightRanks, name: player.name, playerIndex, kind: 'play'
  });

  let logMsg = `${player.name} が ${describePlay(v)} を出した`;
  let effects = [];
  if (v.type === 'set') effects.push({ rank: v.rank, count: v.count });
  else v.straightRanks.forEach(r => { if (EFFECT_RANKS.includes(r) || r === '8') effects.push({ rank: r, count: 1 }); });

  if (v.count >= 4) {
    gs.revolutionCount++;
    logMsg += `(革命!累計${gs.revolutionCount}回)`;
  }

  let cutFlag = false, tobiSteps = 0;
  const queue = [];
  ['6', 'J', '7', '10', '5', '8'].forEach(r => {
    const e = effects.find(x => x.rank === r);
    if (!e) return;
    if (r === '6') { gs.lockSuits = v.suitsUsed.slice(); gs.lockSeq = null; logMsg += `(6ロック発動!次は${gs.lockSuits.join('/')}のみ)`; }
    if (r === 'J') { gs.tempReversed = !gs.tempReversed; logMsg += '(強さ反転)'; }
    if (r === '7') { queue.push({ type: 'give', n: e.count }); }
    if (r === '10') { queue.push({ type: 'discard', n: e.count }); }
    if (r === '5') {
      const skipAmount = 2 * e.count - 1;
      const otherActiveCount = gs.players.filter((p, i) => i !== playerIndex && !p.finished).length;
      if (skipAmount >= otherActiveCount) { cutFlag = true; logMsg += '(5飛び!全員飛ばされたので場が流れます)'; }
      else { tobiSteps += skipAmount + 1; logMsg += '(5飛び)'; }
    }
    if (r === '8') { cutFlag = true; logMsg += '(8切り)'; }
  });
  if (v.isSpade3Counter) { cutFlag = true; tobiSteps = 0; logMsg += '(スペ3でジョーカーを撃破!ターン終了)'; }
  updateSuitChain(gs, v, reversedAtValidation);

  const finishedNow = player.hand.length === 0;
  const unfulfillableGiveDiscard = finishedNow && queue.length > 0;
  const straightContainsEight = finishedNow && v.type === 'straight' && v.straightRanks.includes('8');
  if (unfulfillableGiveDiscard) {
    gs.log = logMsg;
    commitFoulLoss(gs, playerIndex, queue.map(q => q.type === 'give' ? '7渡し' : '10捨て').join('・'));
    return true;
  }
  if (straightContainsEight) {
    gs.log = logMsg;
    commitFoulLoss(gs, playerIndex, '8を含む階段での上がり');
    return true;
  }
  if (finishedNow) {
    player.finished = true; gs.finishOrder.push(playerIndex);
    logMsg += ` → ${player.name}が上がりました!`;
  }
  gs.log = logMsg;

  if (finishedNow) {
    if (checkGameEnd(gs)) return true;
    clearFieldStateKeepScore(gs);
    advance(gs, playerIndex, { tobiSteps: 1 });
    return true;
  }

  if (cutFlag) gs.pendingAfterQueue = { mode: 'cut', owner: playerIndex };
  else if (tobiSteps > 0) gs.pendingAfterQueue = { mode: 'tobi', from: playerIndex, steps: tobiSteps };
  else gs.pendingAfterQueue = { mode: 'normal', from: playerIndex };

  gs.effectQueue = queue;
  processNextQueueItem(gs, playerIndex);
  return true;
}
function resolveTurnFlow(gs) {
  const paq = gs.pendingAfterQueue; gs.pendingAfterQueue = null;
  if (!paq) return;
  if (paq.mode === 'cut') { clearFieldStateKeepScore(gs); gs.currentIndex = paq.owner; gs.selected = []; }
  else if (paq.mode === 'tobi') advance(gs, paq.from, { tobiSteps: paq.steps });
  else advance(gs, paq.from, { tobiSteps: 1 });
}
function processNextQueueItem(gs, actorIndex) {
  if (gs.effectQueue.length === 0) { resolveTurnFlow(gs); return; }
  const item = gs.effectQueue.shift();
  const player = gs.players[actorIndex];
  if (player.hand.length < item.n) {
    commitFoulLoss(gs, actorIndex, item.type === 'give' ? '7渡し' : '10捨て');
    return;
  }
  gs.pendingAction = item.type; gs.pendingCount = item.n; gs.pendingActor = actorIndex;
  gs.selected = [];
  gs.phase = item.type; // 'give' | 'discard'
}
function resolveGiveDiscardCore(gs, actorIndex, type, ids) {
  const player = gs.players[actorIndex];
  const chosen = player.hand.filter(c => ids.includes(c.id));
  player.hand = player.hand.filter(c => !ids.includes(c.id));
  if (type === 'give') {
    const nextIdx = nextActiveRaw(gs, actorIndex);
    gs.players[nextIdx].hand = gs.players[nextIdx].hand.concat(chosen);
    gs.log += ` / ${player.name}が${chosen.length}枚渡した`;
  } else {
    gs.log += ` / ${player.name}が${chosen.length}枚捨てた`;
  }
  gs.pendingAction = null; gs.pendingCount = 0; gs.pendingActor = null; gs.selected = [];
  if (player.hand.length === 0 && !player.finished) {
    player.finished = true; gs.finishOrder.push(actorIndex);
    gs.log += ` → ${player.name}が上がりました!`;
    if (checkGameEnd(gs)) return true;
    gs.effectQueue = [];
    gs.pendingAfterQueue = null;
    clearFieldStateKeepScore(gs);
    gs.phase = 'playing';
    advance(gs, actorIndex, { tobiSteps: 1 });
    return true;
  }
  gs.phase = 'playing';
  return false;
}
function confirmGiveDiscard(gs, actorIndex, ids) {
  if (gs.pendingActor !== actorIndex) return false;
  if (ids.length !== gs.pendingCount) return false;
  const type = gs.pendingAction;
  const finished = resolveGiveDiscardCore(gs, actorIndex, type, ids);
  if (!finished) processNextQueueItem(gs, actorIndex);
  if (gs.phase !== 'result' && gs.phase !== 'give' && gs.phase !== 'discard') gs.phase = 'playing';
  return true;
}
function passTurn(gs, idx) {
  if (gs.field === null) return false;
  if (gs.currentIndex !== idx) return false;
  gs.passedThisField.add(idx);
  gs.log = `${gs.players[idx].name} がパス`;
  gs.trickHistory.push({ kind: 'pass', name: gs.players[idx].name, playerIndex: idx });
  advance(gs, idx, { tobiSteps: 1 });
  return true;
}
function playCards(gs, idx, cardIds) {
  if (gs.currentIndex !== idx) return { ok: false, error: 'not_your_turn' };
  const v = evaluateSelection(gs, idx, cardIds);
  if (!v.ok) return { ok: false, error: v.reason || 'invalid' };
  applyPlay(gs, idx, cardIds);
  return { ok: true };
}

function generateCandidates(hand) {
  const candidates = [];
  const byRank = {};
  hand.forEach(c => { (byRank[c.rank] = byRank[c.rank] || []).push(c); });
  Object.values(byRank).forEach(group => { for (let k = 1; k <= group.length; k++) candidates.push(group.slice(0, k)); });
  const bySuit = {};
  hand.forEach(c => { if (c.suit) (bySuit[c.suit] = bySuit[c.suit] || []).push(c); });
  Object.values(bySuit).forEach(cards => {
    const sorted = cards.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
    let run = [sorted[0]];
    const flush = (run) => {
      if (run.length >= 3) { for (let len = 3; len <= run.length; len++) for (let start = 0; start + len <= run.length; start++) candidates.push(run.slice(start, start + len)); }
    };
    for (let i = 1; i < sorted.length; i++) {
      if (RANKS.indexOf(sorted[i].rank) === RANKS.indexOf(sorted[i - 1].rank) + 1) run.push(sorted[i]);
      else { flush(run); run = [sorted[i]]; }
    }
    flush(run);
  });
  return candidates;
}

function rankLabels(n) {
  if (n <= 1) return ['大富豪'];
  if (n === 2) return ['大富豪', '大貧民'];
  if (n === 3) return ['大富豪', '平民', '大貧民'];
  const labels = ['大富豪', '富豪'];
  for (let i = 0; i < n - 4; i++) labels.push('平民');
  labels.push('貧民', '大貧民');
  return labels;
}

function dealRound(gs) {
  const deck = shuffle(buildDeck());
  const n = gs.players.length;
  gs.players.forEach(p => { p.hand = []; p.finished = false; });
  deck.forEach((c, i) => gs.players[i % n].hand.push(c));
  gs.players.forEach(p => p.hand = sortHand(p.hand));
  let starter = 0;
  gs.players.forEach((p, i) => { if (p.hand.some(c => c.suit === '♦' && c.rank === '3')) starter = i; });
  gs.currentIndex = starter;
  gs.field = null; gs.fieldOwner = null;
  gs.lockSuits = null; gs.lockSeq = null; gs.prevTrack = null;
  gs.passedThisField = new Set();
  gs.revolutionCount = 0; gs.tempReversed = false;
  gs.finishOrder = []; gs.selected = [];
  gs.trickHistory = [];
  gs.log = `ダイヤの3を持つ ${gs.players[starter].name} から開始`;
  gs.pendingAction = null; gs.pendingCount = 0; gs.pendingActor = null; gs.effectQueue = []; gs.pendingAfterQueue = null;
  gs.foulPenalty = null;
  gs.phase = 'playing';
}
function createGameState(playersMeta) {
  const gs = {
    phase: 'playing',
    roundNumber: 1,
    players: playersMeta.map(p => ({ name: p.name, hand: [], finished: false, score: 0 })),
    currentIndex: 0, field: null, fieldOwner: null,
    lockSuits: null, lockSeq: null, prevTrack: null,
    passedThisField: new Set(),
    revolutionCount: 0, tempReversed: false,
    finishOrder: [], selected: [], log: '',
    pendingAction: null, pendingCount: 0, pendingActor: null, effectQueue: [], pendingAfterQueue: null,
    lastRoundPoints: 0, trickHistory: [], foulPenalty: null,
    _leadCheckDepth: 0,
  };
  dealRound(gs);
  return gs;
}

module.exports = {
  buildDeck, shuffle, sortHand, isRed, RANKS, SUITS,
  evaluateSelection, describePlay, playCards, passTurn, confirmGiveDiscard,
  dealRound, createGameState, rankLabels, calculateRoundScore,
};
