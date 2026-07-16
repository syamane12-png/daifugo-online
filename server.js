// 大富豪 オンライン対戦サーバー(依存パッケージなし)
// 起動: node server.js  (デフォルトで http://localhost:3000)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engine = require('./engine');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6時間操作がなければルームを自動破棄
const MAX_PLAYERS = 5;

/** @type {Object<string, Room>} */
const rooms = {};

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0,O,1,I)を除外
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}
function makeToken() { return crypto.randomBytes(16).toString('hex'); }

function createRoom(hostName) {
  const code = makeRoomCode();
  const room = {
    code,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    phase: 'lobby', // 'lobby' | 'playing'
    players: [{ id: 0, token: makeToken(), name: hostName || 'ホスト', connected: true, lastPoll: Date.now() }],
    gs: null,
  };
  rooms[code] = room;
  return room;
}
function joinRoom(code, name) {
  const room = rooms[code];
  if (!room) return { error: 'ルームが見つかりません' };
  if (room.phase !== 'lobby') return { error: 'すでにゲームが始まっています' };
  if (room.players.length >= MAX_PLAYERS) return { error: 'ルームが満員です(最大5人)' };
  const id = room.players.length;
  const token = makeToken();
  room.players.push({ id, token, name: name || `プレイヤー${id + 1}`, connected: true, lastPoll: Date.now() });
  room.lastActivity = Date.now();
  return { room, id, token };
}
function findPlayer(room, id, token) {
  const p = room.players[id];
  if (!p || p.token !== token) return null;
  return p;
}

function serializeForPlayer(room, viewerId) {
  const base = {
    roomCode: room.code,
    phase: room.phase,
    lobbyPlayers: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected })),
    youId: viewerId,
    isHost: viewerId === 0,
  };
  if (room.phase === 'lobby' || !room.gs) return base;
  const gs = room.gs;
  base.roundNumber = gs.roundNumber;
  base.currentIndex = gs.currentIndex;
  base.field = gs.field;
  base.lockSuits = gs.lockSuits;
  base.lockSeq = gs.lockSeq;
  base.revolutionCount = gs.revolutionCount;
  base.tempReversed = gs.tempReversed;
  base.log = gs.log;
  base.trickHistory = gs.trickHistory;
  base.finishOrder = gs.finishOrder;
  base.lastRoundPoints = gs.lastRoundPoints;
  base.foulPenalty = gs.foulPenalty;
  base.gamePhase = gs.phase; // 'playing' | 'give' | 'discard' | 'result'
  base.pendingAction = gs.pendingAction;
  base.pendingCount = gs.pendingCount;
  base.pendingActor = gs.pendingActor;
  base.players = gs.players.map((p, i) => ({
    name: p.name,
    score: p.score,
    finished: p.finished,
    handCount: p.hand.length,
    hand: i === viewerId ? p.hand : undefined,
  }));
  return base;
}

function touchRoom(room) { room.lastActivity = Date.now(); }

function cleanupOldRooms() {
  const now = Date.now();
  Object.keys(rooms).forEach(code => {
    if (now - rooms[code].lastActivity > ROOM_TTL_MS) delete rooms[code];
  });
}
setInterval(cleanupOldRooms, 30 * 60 * 1000);

/* ============================================================
   HTTPハンドラ
   ============================================================ */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ---- API ----
  if (url.pathname === '/api/create' && req.method === 'POST') {
    try {
      const { name } = await readBody(req);
      const room = createRoom(name);
      return sendJson(res, 200, { roomCode: room.code, playerId: 0, token: room.players[0].token });
    } catch (e) { return sendJson(res, 400, { error: 'bad_request' }); }
  }

  if (url.pathname === '/api/join' && req.method === 'POST') {
    try {
      const { roomCode, name } = await readBody(req);
      const result = joinRoom((roomCode || '').toUpperCase().trim(), (name || '').trim());
      if (result.error) return sendJson(res, 400, { error: result.error });
      return sendJson(res, 200, { roomCode: result.room.code, playerId: result.id, token: result.token });
    } catch (e) { return sendJson(res, 400, { error: 'bad_request' }); }
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const roomCode = (url.searchParams.get('roomCode') || '').toUpperCase();
    const playerId = Number(url.searchParams.get('playerId'));
    const token = url.searchParams.get('token');
    const room = rooms[roomCode];
    if (!room) return sendJson(res, 404, { error: 'no_room' });
    const player = findPlayer(room, playerId, token);
    if (!player) return sendJson(res, 403, { error: 'bad_token' });
    player.connected = true; player.lastPoll = Date.now();
    return sendJson(res, 200, serializeForPlayer(room, playerId));
  }

  if (url.pathname === '/api/action' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { roomCode, playerId, token, action } = body;
      const room = rooms[(roomCode || '').toUpperCase()];
      if (!room) return sendJson(res, 404, { error: 'no_room' });
      const player = findPlayer(room, playerId, token);
      if (!player) return sendJson(res, 403, { error: 'bad_token' });
      touchRoom(room);

      const result = handleAction(room, playerId, action || {});
      if (result && result.error) return sendJson(res, 400, { error: result.error });
      return sendJson(res, 200, serializeForPlayer(room, playerId));
    } catch (e) {
      return sendJson(res, 500, { error: 'server_error', detail: String(e && e.message || e) });
    }
  }

  // ---- static files ----
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function handleAction(room, playerId, action) {
  if (action.type === 'start') {
    if (playerId !== 0) return { error: 'host_only' };
    if (room.phase !== 'lobby') return { error: 'already_started' };
    if (room.players.length < 2) return { error: 'need_more_players' };
    room.phase = 'playing';
    room.gs = engine.createGameState(room.players.map(p => ({ name: p.name })));
    return { ok: true };
  }
  if (!room.gs) return { error: 'not_started' };
  const gs = room.gs;

  if (action.type === 'play') {
    if (gs.phase !== 'playing') return { error: 'not_playable_now' };
    const r = engine.playCards(gs, playerId, action.cardIds || []);
    return r.ok ? { ok: true } : { error: r.error };
  }
  if (action.type === 'pass') {
    if (gs.phase !== 'playing') return { error: 'not_playable_now' };
    const ok = engine.passTurn(gs, playerId);
    return ok ? { ok: true } : { error: 'cannot_pass' };
  }
  if (action.type === 'giveDiscard') {
    if (gs.phase !== 'give' && gs.phase !== 'discard') return { error: 'not_pending' };
    const ok = engine.confirmGiveDiscard(gs, playerId, action.cardIds || []);
    return ok ? { ok: true } : { error: 'cannot_confirm' };
  }
  if (action.type === 'nextRound') {
    if (playerId !== 0) return { error: 'host_only' };
    if (gs.phase !== 'result') return { error: 'not_result' };
    gs.roundNumber++;
    engine.dealRound(gs);
    return { ok: true };
  }
  if (action.type === 'backToLobby') {
    if (playerId !== 0) return { error: 'host_only' };
    room.phase = 'lobby';
    room.gs = null;
    return { ok: true };
  }
  return { error: 'unknown_action' };
}

server.listen(PORT, () => {
  console.log(`大富豪オンラインサーバー起動: http://localhost:${PORT}`);
});
