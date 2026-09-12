// SET2-4 同期・公平性 実測用サーバー（使い捨て）
//
// 役割:
//   - 静的ファイルの配信
//   - 2人ルーム（duel）/ 1人キャリブレーション（solo）の進行
//   - ランダム待機後の GO push、TAP の収集、判定（docs/set2-4-sync-fairness.md §5）
//   - RTT 計測用の PING/PONG 中継
//   - 人工遅延の注入（§7.3 の非対称回線を OS 設定なしで再現するため）
//   - 全ラウンドの CSV 記録
//
// 本番構成とは独立。ここでの実装方式は SET2-2 の技術選定を拘束しない。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

// 閾値。すべて実測で決める値なので環境変数で振れるようにしてある（§6）
const cfg = {
  port: num(process.env.PORT, 8787),
  wMin: num(process.env.W_MIN, 1000),        // ランダム待機の下限 [ms]
  wMax: num(process.env.W_MAX, 4000),        // ランダム待機の上限 [ms]
  inputDeadline: num(process.env.T, 3000),   // 入力期限 T [ms]
  tieBand: num(process.env.D, 20),           // 同着幅 D [ms]
  rMin: num(process.env.R_MIN, 100),         // 生理的下限 R_min [ms]
  eps: num(process.env.EPS, 80),             // 整合性検査の許容幅 ε [ms]
};

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
const now = () => performance.now();
const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- CSV

fs.mkdirSync(DATA_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const roundsCsv = path.join(DATA_DIR, `rounds-${stamp}.csv`);
const calibCsv = path.join(DATA_DIR, `calib-${stamp}.csv`);

const ROUND_COLS = [
  'wallclock', 'roomId', 'roundId', 'mode', 'clientId', 'name', 'label',
  'result', 'reason', 'R_ms', 'opponentR_ms', 'diff_ms',
  'flying', 'noInput', 'disconnected', 'invalidReason', 'forged', 'synthetic', 'extraTaps',
  'serverElapsed_ms', 'rttMedian_ms', 'rttP95_ms', 'rttJitter_ms', 'residual_ms',
  'recvToPaint_ms', 'inputToHandler_ms', 'frameInterval_ms', 'refreshHz_est',
  'visibilityOk', 'W_ms', 'delayUp_ms', 'delayDown_ms', 'ua',
];
const CALIB_COLS = [
  'wallclock', 'clientId', 'name', 'label', 'clockResolution_ms',
  'frameInterval_median_ms', 'frameInterval_p95_ms', 'refreshHz_est',
  'rttMedian_ms', 'rttP95_ms', 'rttJitter_ms',
  'dpr', 'cores', 'screen', 'ua',
];
writeHeader(roundsCsv, ROUND_COLS);
writeHeader(calibCsv, CALIB_COLS);

function writeHeader(file, cols) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, cols.join(',') + '\n');
}
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function appendRow(file, cols, obj) {
  fs.appendFile(file, cols.map((c) => csvCell(obj[c])).join(',') + '\n', () => {});
}
const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ---------------------------------------------------------------- 静的配信

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
});

// ---------------------------------------------------------------- ルーム

/** @type {Map<string, Room>} */
const rooms = new Map();
let clientSeq = 0;

function getRoom(id, mode) {
  let room = rooms.get(id);
  if (!room) {
    room = { id, mode, state: 'WAITING', clients: [], round: null, roundSeq: 0 };
    rooms.set(id, room);
  }
  return room;
}

const capacityOf = (room) => (room.mode === 'solo' ? 1 : 2);

function broadcast(room, msg) { for (const c of room.clients) send(c, msg); }

function send(client, msg) {
  const payload = JSON.stringify(msg);
  const fire = () => { if (client.ws.readyState === 1) client.ws.send(payload); };
  // delayDown は「サーバー→端末」の片道遅延を模す
  if (client.delayDown > 0) setTimeout(fire, client.delayDown);
  else fire();
}

function roomSnapshot(room) {
  return {
    state: room.state,
    capacity: capacityOf(room),
    members: room.clients.map((c) => ({ id: c.id, name: c.name, ready: c.ready })),
  };
}
function pushState(room) { broadcast(room, { type: 'STATE', room: roomSnapshot(room), cfg }); }

// ---------------------------------------------------------------- ラウンド進行

function tryStart(room) {
  if (room.state !== 'WAITING') return;
  const need = capacityOf(room);
  if (room.clients.length < need) return;
  if (!room.clients.every((c) => c.ready)) return;

  room.state = 'ARMED';
  const w = rand(cfg.wMin, cfg.wMax);
  const round = {
    id: ++room.roundSeq,
    w,
    goSentAt: null,
    participants: [...room.clients],
    rec: new Map(),
    resolved: false,
    goTimer: null,
    deadlineTimer: null,
  };
  for (const c of round.participants) {
    round.rec.set(c.id, { client: c, tap: null, tapRecvAt: null, disconnectedAt: null, sawGo: false });
  }
  room.round = round;
  broadcast(room, { type: 'ARMED', roundId: round.id });
  pushState(room);

  round.goTimer = setTimeout(() => {
    if (room.round !== round || round.resolved) return;
    room.state = 'CUE';
    // t_go_sent は「サーバーが送信を開始した時刻」。人工遅延は回線の代わりなので、この後に入る
    round.goSentAt = now();
    for (const c of round.participants) {
      round.rec.get(c.id).sawGo = true;
      send(c, { type: 'GO', roundId: round.id });
    }
    const maxDelay = Math.max(0, ...round.participants.map((c) => c.delayUp + c.delayDown));
    round.deadlineTimer = setTimeout(
      () => resolveRound(room, round),
      cfg.inputDeadline + maxDelay + 700,
    );
  }, w);
}

function onTap(client, msg) {
  const room = client.room;
  const round = room?.round;
  if (!round || round.resolved) return;
  const rec = round.rec.get(client.id);
  if (!rec) return;
  if (rec.tap) { rec.tap.extraTaps = (rec.tap.extraTaps ?? 0) + 1; return; } // §5 ケース12 連打

  rec.tapRecvAt = now(); // 人工遅延の適用後に記録する（回線通過後の到着時刻に相当）
  rec.tap = {
    flying: !!msg.flying,
    R: typeof msg.R === 'number' ? msg.R : null,
    recvToPaint: msg.recvToPaint ?? null,
    inputToHandler: msg.inputToHandler ?? null,
    frameInterval: msg.frameInterval ?? null,
    visibilityOk: msg.visibilityOk !== false,
    forged: !!msg.forged,
    synthetic: !!msg.synthetic,
    extraTaps: msg.extraTaps ?? 0,
    rtt: msg.rtt ?? null,
  };

  const done = round.participants.every((c) => {
    const r = round.rec.get(c.id);
    return r.tap || r.disconnectedAt;
  });
  if (done) resolveRound(room, round);
}

function summarize(rec, round) {
  const c = rec.client;
  const tap = rec.tap;
  const rtt = tap?.rtt ?? {};
  const serverElapsed = rec.tapRecvAt !== null && round.goSentAt !== null
    ? rec.tapRecvAt - round.goSentAt
    : null;
  // 整合性検査（§3 方式C-2）: 正直な計測なら serverElapsed ≒ RTT + R となり residual ≒ 0
  const residual = serverElapsed !== null && tap?.R !== null && typeof rtt.median === 'number'
    ? serverElapsed - tap.R - rtt.median
    : null;

  return {
    id: c.id,
    name: c.name,
    label: c.label,
    client: c,
    flying: !!tap?.flying,
    R: tap?.R ?? null,
    noInput: !tap && !rec.disconnectedAt,
    disconnected: !!rec.disconnectedAt,
    disconnectedBeforeGo: !!rec.disconnectedAt && !rec.sawGo,
    disconnectedAfterGo: !!rec.disconnectedAt && rec.sawGo,
    tap,
    rtt,
    serverElapsed,
    residual,
  };
}

/** §5 ケース9・10・11。無効試合であって不正の断定ではない */
function invalidReason(p) {
  if (p.flying || p.noInput || p.disconnected) return null;
  if (p.R === null) return null;
  if (p.R < cfg.rMin) return `生理的下限未満(R=${r2(p.R)}ms < ${cfg.rMin}ms)`;
  if (p.residual !== null && Math.abs(p.residual) > cfg.eps) {
    return `整合性違反(residual=${r2(p.residual)}ms)`;
  }
  if (p.tap && p.tap.visibilityOk === false) return 'バックグラウンド化';
  return null;
}

/**
 * docs/set2-4-sync-fairness.md §5 の判定。
 * 優先順位: 切断(GO前) > フライング > 切断(GO後) > 無効 > 無入力 > 同着 > 反応時間比較
 */
function decide(a, b) {
  const out = (ra, rb, reason) => ({ [a.id]: ra, [b.id]: rb, reason });
  const draw = (reason) => out('draw', 'draw', reason);
  const voidMatch = (reason) => out('void', 'void', reason);
  const win = (w, l, reason) =>
    w.id === a.id ? out('win', 'lose', reason) : out('lose', 'win', reason);

  if (a.disconnectedBeforeGo || b.disconnectedBeforeGo) return voidMatch('切断(GO前)');       // ケース7
  if (a.flying && b.flying) return draw('双方フライング');                                     // ケース4
  if (a.flying) return win(b, a, 'フライング');                                                // ケース3
  if (b.flying) return win(a, b, 'フライング');
  if (a.disconnectedAfterGo && b.disconnectedAfterGo) return voidMatch('双方切断(GO後)');
  if (a.disconnectedAfterGo) return win(b, a, '切断による不戦勝');                             // ケース8
  if (b.disconnectedAfterGo) return win(a, b, '切断による不戦勝');

  const ia = invalidReason(a), ib = invalidReason(b);
  if (ia || ib) return voidMatch(`無効試合: ${[ia, ib].filter(Boolean).join(' / ')}`);          // ケース9,10,11
  if (a.noInput && b.noInput) return draw('双方無入力');                                       // ケース6
  if (a.noInput) return win(b, a, '相手が無入力');                                             // ケース5
  if (b.noInput) return win(a, b, '相手が無入力');
  if (Math.abs(a.R - b.R) <= cfg.tieBand) return draw(`同着(差${r2(Math.abs(a.R - b.R))}ms)`);  // ケース2
  return a.R < b.R ? win(a, b, '反応が速い') : win(b, a, '反応が速い');                         // ケース1
}

function resolveRound(room, round) {
  if (round.resolved) return;
  round.resolved = true;
  clearTimeout(round.goTimer);
  clearTimeout(round.deadlineTimer);

  const players = round.participants.map((c) => summarize(round.rec.get(c.id), round));
  let verdict, reason;

  if (players.length === 2) {
    const d = decide(players[0], players[1]);
    reason = d.reason;
    verdict = { [players[0].id]: d[players[0].id], [players[1].id]: d[players[1].id] };
  } else {
    // solo は勝敗をつけず、計測値だけを残す（§7.1 / §7.2 用）
    const p = players[0];
    const inv = invalidReason(p);
    reason = p.flying ? 'フライング' : p.noInput ? '無入力' : inv ? `無効試合: ${inv}` : '計測のみ';
    verdict = { [p.id]: inv || p.flying || p.noInput ? 'void' : 'solo' };
  }

  const wallclock = new Date().toISOString();
  for (const p of players) {
    const other = players.find((x) => x.id !== p.id);
    const fi = p.tap?.frameInterval ?? null;
    appendRow(roundsCsv, ROUND_COLS, {
      wallclock,
      roomId: room.id,
      roundId: round.id,
      mode: room.mode,
      clientId: p.id,
      name: p.name,
      label: p.label,
      result: verdict[p.id],
      reason,
      R_ms: r2(p.R),
      opponentR_ms: r2(other?.R ?? null),
      diff_ms: p.R !== null && other?.R != null ? r2(Math.abs(p.R - other.R)) : null,
      flying: p.flying,
      noInput: p.noInput,
      disconnected: p.disconnected,
      invalidReason: invalidReason(p) ?? '',
      forged: p.tap?.forged ?? '',
      synthetic: p.tap?.synthetic ?? '',
      extraTaps: p.tap?.extraTaps ?? 0,
      serverElapsed_ms: r2(p.serverElapsed),
      rttMedian_ms: r2(p.rtt?.median),
      rttP95_ms: r2(p.rtt?.p95),
      rttJitter_ms: r2(p.rtt?.jitter),
      residual_ms: r2(p.residual),
      recvToPaint_ms: r2(p.tap?.recvToPaint),
      inputToHandler_ms: r2(p.tap?.inputToHandler),
      frameInterval_ms: r2(fi),
      refreshHz_est: fi ? Math.round(1000 / fi) : null,
      visibilityOk: p.tap?.visibilityOk ?? '',
      W_ms: r2(round.w),
      delayUp_ms: p.client.delayUp,
      delayDown_ms: p.client.delayDown,
      ua: p.client.ua,
    });
  }

  broadcast(room, {
    type: 'RESULT',
    roundId: round.id,
    reason,
    w: r2(round.w),
    players: players.map((p) => ({
      id: p.id, name: p.name, result: verdict[p.id],
      R: r2(p.R), flying: p.flying, noInput: p.noInput, disconnected: p.disconnected,
      invalid: invalidReason(p), serverElapsed: r2(p.serverElapsed), residual: r2(p.residual),
      recvToPaint: r2(p.tap?.recvToPaint), frameInterval: r2(p.tap?.frameInterval),
    })),
  });

  for (const c of room.clients) c.ready = false;
  room.state = 'WAITING';
  room.round = null;
  pushState(room);
}

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room') || 'lab';
  const mode = url.searchParams.get('mode') === 'solo' ? 'solo' : 'duel';
  const room = getRoom(roomId, mode);

  if (room.clients.length >= capacityOf(room)) {
    ws.send(JSON.stringify({ type: 'FULL', capacity: capacityOf(room) }));
    ws.close();
    return;
  }

  const client = {
    id: 'c' + (++clientSeq),
    ws,
    room,
    name: (url.searchParams.get('name') || 'p' + clientSeq).slice(0, 24),
    label: (url.searchParams.get('label') || '').slice(0, 48), // 端末・回線条件のメモ
    delayUp: Math.max(0, num(url.searchParams.get('delayUp'), 0)),
    delayDown: Math.max(0, num(url.searchParams.get('delayDown'), 0)),
    ua: req.headers['user-agent'] ?? '',
    ready: false,
  };
  room.clients.push(client);
  send(client, {
    type: 'WELCOME',
    clientId: client.id, roomId: room.id, mode: room.mode,
    delayUp: client.delayUp, delayDown: client.delayDown, cfg,
  });
  pushState(room);
  console.log(`[${room.id}] + ${client.name} (${client.id}) up=${client.delayUp} down=${client.delayDown}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // delayUp は「端末→サーバー」の片道遅延を模す。到着時刻の記録は遅延適用後
    if (client.delayUp > 0) setTimeout(() => handle(client, msg), client.delayUp);
    else handle(client, msg);
  });

  ws.on('close', () => {
    const room = client.room;
    const idx = room.clients.indexOf(client);
    if (idx >= 0) room.clients.splice(idx, 1);
    console.log(`[${room.id}] - ${client.name} (${client.id})`);

    const round = room.round;
    if (round && !round.resolved && round.rec.has(client.id)) {
      round.rec.get(client.id).disconnectedAt = now();
      const done = round.participants.every((c) => {
        const r = round.rec.get(c.id);
        return r.tap || r.disconnectedAt;
      });
      if (done) resolveRound(room, round);
    }
    if (room.clients.length === 0) rooms.delete(room.id);
    else pushState(room);
  });
});

function handle(client, msg) {
  switch (msg.type) {
    case 'PING':
      send(client, { type: 'PONG', seq: msg.seq, t: msg.t });
      break;
    case 'READY':
      client.ready = true;
      pushState(client.room);
      tryStart(client.room);
      break;
    case 'TAP':
      onTap(client, msg);
      break;
    case 'CALIB':
      appendRow(calibCsv, CALIB_COLS, {
        wallclock: new Date().toISOString(),
        clientId: client.id, name: client.name, label: client.label,
        clockResolution_ms: msg.clockResolution ?? null,
        frameInterval_median_ms: r2(msg.frameIntervalMedian),
        frameInterval_p95_ms: r2(msg.frameIntervalP95),
        refreshHz_est: msg.frameIntervalMedian ? Math.round(1000 / msg.frameIntervalMedian) : null,
        rttMedian_ms: r2(msg.rtt?.median), rttP95_ms: r2(msg.rtt?.p95), rttJitter_ms: r2(msg.rtt?.jitter),
        dpr: msg.dpr ?? null, cores: msg.cores ?? null, screen: msg.screen ?? null, ua: client.ua,
      });
      send(client, { type: 'CALIB_OK' });
      break;
  }
}

// ---------------------------------------------------------------- 起動

server.listen(cfg.port, () => {
  const addrs = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('reaction-lab (SET2-4 実測用)');
  console.log('  設定:', cfg);
  console.log(`  ローカル : http://localhost:${cfg.port}/`);
  for (const a of addrs) console.log(`  LAN      : http://${a}:${cfg.port}/   ← スマホからはこちら`);
  console.log(`  CSV      : ${path.relative(process.cwd(), roundsCsv)}`);
  console.log(`             ${path.relative(process.cwd(), calibCsv)}`);
});
