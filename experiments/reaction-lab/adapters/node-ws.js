// Node + ws アダプタ。
//
// core/match.js は I/O を持たないので、ここが唯一の副作用の置き場になる。
//   - HTTP 静的配信と WebSocket
//   - core が返したコマンド（send / broadcast / setTimer / clearTimer / closed）の実行
//   - 人工遅延の注入（実回線の代用。docs/set2-4-sync-fairness.md §7.3）
//   - CSV 記録
//
// Durable Objects アダプタを書く場合も、core はそのまま使える。
// ただし本番 Workers は Date.now() が I/O のたびにしか進まないため、
// now() に何を渡すかを実測で確かめること（docs/set2-2-realtime-match.md §9.3）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { createMatch, DEFAULT_CFG, TIMER } from '../core/match.js';
import { createStats } from '../core/stats.js';
import { pickPair, isEngaged } from '../core/lobby.js';
import { gameDate, msUntilReset } from '../core/clock.js';
import { nickname } from '../core/nickname.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

const now = () => performance.now();

// ---------------------------------------------------------------- 匿名 identity
//
// kusa は識別情報を渡してこないので、こちらで非公開の Cookie を発行する。
// 中身は UUID だけで、ゲームの状態は持たせない。
// docs/set2-6-stats-ranking.md §3

const COOKIE_NAME = 'puyuri_token';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function readToken(req) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      const v = part.slice(i + 1).trim();
      return /^[0-9a-f-]{36}$/i.test(v) ? v : null;
    }
  }
  return null;
}

/**
 * Partitioned を落とさないこと。
 * サードパーティ Cookie を遮断するブラウザ（iOS Safari など）では
 * SameSite=None だけでは保存されず、アクセスのたびに別人が作られる。
 * Partitioned を付けると埋め込み元ごとに分離された領域に保存され、遮断下でも機能する。
 * 属性を知らない古いブラウザは無視するだけなので付けて損はない。
 */
function cookieHeader(token, secure) {
  const attrs = [
    `${COOKIE_NAME}=${token}`, 'Path=/', `Max-Age=${COOKIE_MAX_AGE}`, 'HttpOnly',
  ];
  // ローカルの平文 http で動作確認するために可変。本番は必ず secure
  if (secure) attrs.push('Secure', 'SameSite=None', 'Partitioned');
  else attrs.push('SameSite=Lax');
  return attrs.join('; ');
}
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// ---------------------------------------------------------------- CSV

const ROUND_COLS = [
  'wallclock', 'roomId', 'matchId', 'roundId', 'resultId', 'mode', 'clientId', 'name', 'label',
  'result', 'reason', 'R_ms', 'recorded', 'opponentR_ms', 'diff_ms',
  'flying', 'tooFast', 'noInput', 'disconnected', 'forged', 'synthetic', 'extraTaps',
  'serverElapsed_ms', 'rttMedian_ms', 'rttP95_ms', 'rttJitter_ms', 'rttClientClaimed_ms', 'residual_ms',
  'recvToPaint_ms', 'inputToHandler_ms', 'frameInterval_ms', 'refreshHz_est',
  'W_ms', 'delayUp_ms', 'delayDown_ms',
];
const CALIB_COLS = [
  'wallclock', 'clientId', 'name', 'label', 'clockResolution_ms',
  'frameInterval_median_ms', 'frameInterval_p95_ms', 'refreshHz_est',
  'rttMedian_ms', 'rttP95_ms', 'rttJitter_ms', 'dpr', 'cores', 'screen',
];

function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function percentile(a, q) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
function jitter(a) { if (a.length < 2) return null; let t = 0; for (let i = 1; i < a.length; i++) t += Math.abs(a[i] - a[i - 1]); return t / (a.length - 1); }
const rttStats = (a) => ({ median: median(a), p95: percentile(a, 0.95), jitter: jitter(a), n: a.length });

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function makeCsv(file, cols, enabled = true) {
  if (!enabled) return () => {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, cols.join(',') + '\n');
  return (obj) => fs.appendFile(file, cols.map((c) => csvCell(obj[c])).join(',') + '\n', () => {});
}

// ---------------------------------------------------------------- 起動

export function startServer(options = {}) {
  const cfg = {
    ...DEFAULT_CFG,
    wMin: num(process.env.W_MIN, DEFAULT_CFG.wMin),
    wMax: num(process.env.W_MAX, DEFAULT_CFG.wMax),
    inputDeadline: num(process.env.T, DEFAULT_CFG.inputDeadline),
    tieBand: num(process.env.D, DEFAULT_CFG.tieBand),
    rMin: num(process.env.R_MIN, DEFAULT_CFG.rMin),
    ...options.cfg,
  };
  const port = num(process.env.PORT, options.port ?? 8787);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const roundsCsv = path.join(DATA_DIR, `rounds-${stamp}.csv`);
  const calibCsv = path.join(DATA_DIR, `calib-${stamp}.csv`);
  const csvEnabled = options.csv !== false; // テストでは切る
  const appendRound = makeCsv(roundsCsv, ROUND_COLS, csvEnabled);
  const appendCalib = makeCsv(calibCsv, CALIB_COLS, csvEnabled);

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
  };
  // Railway など TLS 終端の後ろに置かれる場合、req 自体は平文で届く。
  // 環境変数の設定漏れで Cookie の属性が落ちると iOS Safari で identity が保てないので、
  // x-forwarded-proto も見て自動で判断する。
  const forceSecure = process.env.COOKIE_SECURE === '1';
  const isSecure = (req) => forceSecure || req.headers['x-forwarded-proto'] === 'https';
  const stats = createStats();
  setInterval(() => stats.prune(), 60 * 60 * 1000).unref?.();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // どのレスポンスでも Cookie を書き直して有効期限をスライドさせる
    const token = readToken(req) ?? randomUUID();
    const headers = { 'set-cookie': cookieHeader(token, isSecure(req)), 'cache-control': 'no-store' };

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, date: gameDate() }));
      return;
    }

    if (url.pathname === '/api/ranking') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(stats.ranking()));
      return;
    }

    const rel = url.pathname === '/' ? '/game.html' : url.pathname;
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(buf);
    });
  });

  /** @type {Map<string, Room>} */
  const rooms = new Map();
  let clientSeq = 0, matchSeq = 0;

  // 待機列。docs/set2-3-matchmaking.md
  /** @type {Array<{client: object, token: string, joinedAt: number}>} */
  const queue = [];
  /** 対戦中の token。1 token = 1所属（§3.3） */
  const engagedTokens = new Set();
  const WAIT_LIMIT = num(process.env.WAIT_LIMIT, 90_000);
  const READY_LIMIT = num(process.env.READY_LIMIT, 30_000);

  function rawSend(client, payload) {
    if (client.ws.readyState === 1) client.ws.send(payload);
  }
  function send(client, msg) {
    const payload = JSON.stringify(msg);
    // delayDown は「サーバー→端末」の片道遅延を模す
    if (client.delayDown > 0) setTimeout(() => rawSend(client, payload), client.delayDown);
    else rawSend(client, payload);
  }

  function getRoom(id, mode) {
    let room = rooms.get(id);
    if (!room) {
      room = { id, mode, clients: [], match: null, matchId: null, timers: {} };
      rooms.set(id, room);
    }
    return room;
  }
  const capacityOf = (room) => (room.mode === 'solo' ? 1 : 2);

  function clearTimer(room, name) {
    if (room.timers[name]) { clearTimeout(room.timers[name]); delete room.timers[name]; }
  }
  function clearAllTimers(room) {
    for (const name of Object.keys(room.timers)) clearTimer(room, name);
  }

  /** core が返したコマンドを実行する */
  function exec(room, cmds) {
    for (const c of cmds) {
      switch (c.type) {
        case 'broadcast':
          for (const cl of room.clients) send(cl, c.msg);
          if (c.msg.type === 'RESULT') { logResult(room, c.msg); recordResult(room, c.msg); }
          break;
        case 'send': {
          const cl = room.clients.find((x) => x.id === c.to);
          if (cl) send(cl, c.msg);
          break;
        }
        case 'setTimer': {
          clearTimer(room, c.name);
          // 人工遅延を入れている場合、入力が届くまでの猶予を足す
          const slack = c.name === TIMER.DEADLINE
            ? Math.max(0, ...room.clients.map((x) => x.delayUp + x.delayDown)) + 700 : 0;
          room.timers[c.name] = setTimeout(() => {
            delete room.timers[c.name];
            if (room.match) exec(room, room.match.handle({ type: 'TIMER', name: c.name }));
          }, c.delayMs + slack);
          break;
        }
        case 'clearTimer':
          clearTimer(room, c.name);
          break;
        case 'closed':
          destroyRoom(room);
          break;
      }
    }
  }

  /** 判定結果を当日の戦績に取り込み、本人向けの戦績とランキングを返す */
  function recordResult(room, result) {
    const tokenOf = (clientId) => room.clients.find((c) => c.id === clientId)?.token ?? null;
    stats.record(result, tokenOf);
    const rank = stats.ranking();
    for (const c of room.clients) {
      send(c, { type: 'STATS', daily: publicDaily(stats.daily(c.token)), ranking: rank });
    }
  }

  /** 本人向けでも token は返さない */
  const publicDaily = (d) => ({
    name: d.name, games: d.games, win: d.win, lose: d.lose, draw: d.draw, voided: d.voided,
    bestR: d.bestR === null ? null : Math.round(d.bestR), streak: d.streak, bestStreak: d.bestStreak,
  });

  // ---------------------------------------------------------------- 待機列

  function leaveQueue(client) {
    const i = queue.findIndex((e) => e.client === client);
    if (i >= 0) queue.splice(i, 1);
    clearTimeout(client.waitTimer);
  }

  function joinQueue(client) {
    // 同じ接続からの二度押し。別タブ扱いにすると誤解を招くので、状態を返すだけ
    if (queue.some((e) => e.client === client)) { send(client, { type: 'QUEUED' }); return; }
    if (client.room) return; // すでに対戦中
    // 別の接続が同じ token を握っている＝別タブ（docs/set2-3-matchmaking.md §3.3）
    if (isEngaged(client.token, { queue, engagedTokens })) {
      send(client, { type: 'QUEUE_REJECTED', reason: 'already-engaged' });
      return;
    }
    queue.push({ client, token: client.token, joinedAt: Date.now() });
    send(client, { type: 'QUEUED' });
    client.waitTimer = setTimeout(() => {
      leaveQueue(client);
      send(client, { type: 'WAIT_TIMEOUT' });
    }, WAIT_LIMIT);
    tryPair();
  }

  /** 待機列の先頭から token が異なる2人を組む。取り出した時点で確定させる（§4） */
  function tryPair() {
    for (;;) {
      const pair = pickPair(queue);
      if (!pair) return;
      const [i, j] = pair;
      const b = queue.splice(j, 1)[0];
      const a = queue.splice(i, 1)[0];
      clearTimeout(a.client.waitTimer); clearTimeout(b.client.waitTimer);
      if (a.client.ws.readyState !== 1 || b.client.ws.readyState !== 1) continue;
      openRoom(a.client, b.client);
    }
  }

  function openRoom(c1, c2) {
    const id = 'q' + (++matchSeq);
    const room = { id, mode: 'duel', clients: [c1, c2], match: null, matchId: null, timers: {}, queued: true };
    rooms.set(id, room);
    c1.room = room; c2.room = room;
    engagedTokens.add(c1.token); engagedTokens.add(c2.token);
    startMatchIfReady(room);
    // 準備完了期限。放置で相手を縛らない（§4）
    room.timers.ready = setTimeout(() => {
      if (room.match && room.match.state === 'WAITING') {
        for (const c of [...room.clients]) send(c, { type: 'READY_TIMEOUT' });
        destroyRoom(room);
      }
    }, READY_LIMIT);
  }

  function destroyRoom(room) {
    clearAllTimers(room);
    room.match = null;
    if (room.queued) {
      for (const c of room.clients) { engagedTokens.delete(c.token); c.room = null; }
      rooms.delete(room.id);
      return;
    }
    if (room.clients.length === 0) rooms.delete(room.id);
    else startMatchIfReady(room); // 誰か残っていれば次のマッチを用意する
  }

  function startMatchIfReady(room) {
    if (room.match) return;
    if (room.clients.length < capacityOf(room)) return;
    room.matchId = 'm' + (++matchSeq);
    room.match = createMatch({
      matchId: room.matchId,
      players: room.clients.map((c) => ({ id: c.id, name: c.name, label: c.label })),
      now, cfg,
    });
    for (const c of room.clients) {
      send(c, {
        type: 'MATCHED',
        matchId: room.matchId,
        // 相手の clientId も token も渡さない。騙りの材料を減らす（SET2-2 §7）
        peer: room.clients.filter((x) => x.id !== c.id).map((x) => x.name),
        you: c.nick,
        cfg,
      });
    }
    exec(room, [{ type: 'broadcast', msg: { type: 'STATE', ...room.match.snapshot() } }]);
  }

  function logResult(room, result) {
    const wallclock = new Date().toISOString();
    for (const p of result.players) {
      const cl = room.clients.find((x) => x.id === p.id) ?? {};
      const other = result.players.find((x) => x.id !== p.id);
      const fi = p.frameInterval;
      appendRound({
        wallclock, roomId: room.id, matchId: result.matchId, roundId: result.roundId,
        resultId: result.resultId, mode: room.mode,
        clientId: p.id, name: p.name, label: cl.label ?? '',
        result: p.result, reason: result.reason,
        R_ms: p.R, recorded: result.recorded,
        opponentR_ms: other?.R ?? null,
        diff_ms: p.R != null && other?.R != null ? r2(Math.abs(p.R - other.R)) : null,
        flying: p.flying, tooFast: p.tooFast, noInput: p.noInput, disconnected: p.disconnected,
        forged: cl.lastForged ?? '', synthetic: cl.lastSynthetic ?? '', extraTaps: p.extraTaps,
        serverElapsed_ms: p.serverElapsed,
        rttMedian_ms: r2(cl.lastServerRtt?.median), rttP95_ms: r2(cl.lastServerRtt?.p95),
        rttJitter_ms: r2(cl.lastServerRtt?.jitter), rttClientClaimed_ms: r2(cl.lastRtt?.median),
        residual_ms: p.residual,
        recvToPaint_ms: p.recvToPaint, inputToHandler_ms: p.inputToHandler,
        frameInterval_ms: fi, refreshHz_est: fi ? Math.round(1000 / fi) : null,
        W_ms: result.w, delayUp_ms: cl.delayUp ?? 0, delayDown_ms: cl.delayDown ?? 0,
      });
    }
  }

  // ---------------------------------------------------------------- WebSocket

  // 受信サイズの上限。やり取りする JSON はどれも数百バイトなので 4KB で十分に余裕がある。
  // 公開エンドポイントなので、これが無いと巨大なメッセージを素直に受けてメモリを食う。
  // 超えた接続は ws が 1009 で閉じる。
  const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 });
  wss.on('error', (err) => console.log(`[wss error] ${err.message}`));

  // Origin 制限。既定では無効（ローカル開発と kusa 埋め込みの両方で動かすため）。
  // ALLOWED_ORIGINS="https://example.com,https://foo" で有効になる。
  // ブラウザ以外のクライアントは Origin を自由に詐称できるので、これは強い防御ではない。
  // 実質的な防御は SET2-2 §7（clientId は接続から引く・参加者リストはサーバーが作る）のほう。
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  function originAllowed(req) {
    if (allowedOrigins.length === 0) return true;
    return allowedOrigins.includes(req.headers.origin ?? '');
  }

  wss.on('connection', (ws, req) => {
    if (!originAllowed(req)) {
      console.log(`[reject] origin=${req.headers.origin ?? '(なし)'}`);
      ws.close(1008, 'origin not allowed');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const queued = url.searchParams.get('mode') === 'queue';
    const roomId = url.searchParams.get('room') || 'lab';
    const mode = url.searchParams.get('mode') === 'solo' ? 'solo' : 'duel';
    const room = queued ? null : getRoom(roomId, mode);

    if (room && room.clients.length >= capacityOf(room)) {
      ws.send(JSON.stringify({ type: 'FULL', capacity: capacityOf(room) }));
      ws.close();
      return;
    }

    // Cookie が2回目以降も届かないなら、そのブラウザは保存していない（§3.3）
    const cookieToken = readToken(req);
    const client = {
      id: 'c' + (++clientSeq), ws, room,
      token: cookieToken ?? 'anon:' + randomUUID(),
      cookieReceived: cookieToken !== null,
      name: (url.searchParams.get('name') || 'p' + clientSeq).slice(0, 24),
      label: (url.searchParams.get('label') || '').slice(0, 48),
      delayUp: Math.max(0, num(url.searchParams.get('delayUp'), 0)),
      delayDown: Math.max(0, num(url.searchParams.get('delayDown'), 0)),
      rtts: [], pings: new Map(), pingSeq: 0,
    };
    // 対戦では二つ名を使う。lab（room 指定）はデバッグ用なので name パラメータのまま
    client.nick = nickname(client.token, gameDate());
    if (queued) client.name = client.nick;
    // サーバー発の PING。人工遅延も通るので、測れるのは「サーバーから見た」往復時間
    client.pingTimer = setInterval(() => {
      if (ws.readyState !== 1) return;
      const seq = ++client.pingSeq;
      client.pings.set(seq, now());
      if (client.pings.size > 30) client.pings.delete([...client.pings.keys()][0]);
      send(client, { type: 'SPING', seq });
    }, 400);
    if (room) room.clients.push(client);
    send(client, {
      type: 'WELCOME', clientId: client.id, roomId: room?.id ?? null, mode: queued ? 'queue' : room.mode, cfg,
      delayUp: client.delayUp, delayDown: client.delayDown,
      you: client.nick,                       // その日限りの二つ名
      cookieReceived: client.cookieReceived,  // false が続くなら記録が残らない
      daily: publicDaily(stats.daily(client.token)),
      ranking: stats.ranking(),
      msUntilReset: msUntilReset(),
    });
    if (room) startMatchIfReady(room);
    console.log(`[${room?.id ?? 'queue'}] + ${client.name} (${client.id})`);

    // ハンドラが無いと 'error' が未処理例外になりプロセスごと落ちる。
    // 上限超過のメッセージ1通でサーバーが止まるので、必ず受けておく。
    ws.on('error', (err) => {
      console.log(`[ws error] ${client.id}: ${err.message}`);
      try { ws.close(); } catch { /* 既に閉じている */ }
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // delayUp は「端末→サーバー」の片道遅延を模す。到着時刻の記録は遅延適用後
      if (client.delayUp > 0) setTimeout(() => handle(client, msg), client.delayUp);
      else handle(client, msg);
    });

    ws.on('close', () => {
      clearInterval(client.pingTimer);
      leaveQueue(client);                 // 待機中の切断（§4）
      engagedTokens.delete(client.token);
      const r = client.room;
      if (!r) { tryPair(); return; }
      const idx = r.clients.indexOf(client);
      if (idx >= 0) r.clients.splice(idx, 1);
      console.log(`[${r.id}] - ${client.name} (${client.id})`);
      if (r.match) exec(r, r.match.handle({ type: 'DISCONNECT', clientId: client.id }));
      if (r.clients.length === 0) { clearAllTimers(r); rooms.delete(r.id); }
      tryPair();
    });
  });

  function handle(client, msg) {
    const room = client.room;
    switch (msg.type) {
      case 'JOIN':
        joinQueue(client);
        break;
      case 'LEAVE_QUEUE':
        leaveQueue(client);
        send(client, { type: 'QUEUE_LEFT' });
        break;
      case 'STATS_REQ':
        send(client, { type: 'STATS', daily: publicDaily(stats.daily(client.token)), ranking: stats.ranking() });
        break;
      case 'PING':
        send(client, { type: 'PONG', seq: msg.seq });
        break;
      case 'READY':
        if (room.match) exec(room, room.match.handle({ ...msg, clientId: client.id }));
        break;
      case 'SPONG': {
        // サーバー発 PING の応答。RTT はサーバーが自分で測る（自己申告を信用しない）
        const sentAt = client.pings.get(msg.seq);
        if (sentAt !== undefined) {
          client.rtts.push(now() - sentAt);
          if (client.rtts.length > 60) client.rtts.shift();
          client.pings.delete(msg.seq);
        }
        break;
      }
      case 'TAP':
        // 診断値のうち CSV にしか使わないものはアダプタ側で保持する
        client.lastRtt = msg.rtt ?? null;
        client.lastForged = !!msg.forged;
        client.lastSynthetic = !!msg.synthetic;
        client.lastServerRtt = rttStats(client.rtts);
        if (room.match) {
          exec(room, room.match.handle({ ...msg, clientId: client.id, serverRtt: client.lastServerRtt }));
        }
        break;
      case 'LEAVE':
        if (room.match) exec(room, room.match.handle({ type: 'LEAVE', clientId: client.id }));
        break;
      case 'CALIB':
        appendCalib({
          wallclock: new Date().toISOString(), clientId: client.id, name: client.name, label: client.label,
          clockResolution_ms: msg.clockResolution ?? null,
          frameInterval_median_ms: r2(msg.frameIntervalMedian), frameInterval_p95_ms: r2(msg.frameIntervalP95),
          refreshHz_est: msg.frameIntervalMedian ? Math.round(1000 / msg.frameIntervalMedian) : null,
          rttMedian_ms: r2(msg.rtt?.median), rttP95_ms: r2(msg.rtt?.p95), rttJitter_ms: r2(msg.rtt?.jitter),
          dpr: msg.dpr ?? null, cores: msg.cores ?? null, screen: msg.screen ?? null,
        });
        send(client, { type: 'CALIB_OK' });
        break;
    }
  }

  if (options.quiet) console.log = () => {};
  server.listen(port, () => {
    const addrs = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log('reaction-lab (SET2-4 / SET2-2 検証用)');
    console.log('  設定:', { port, ...cfg });
    console.log(`  ローカル : http://localhost:${port}/`);
    for (const a of addrs) console.log(`  LAN      : http://${a}:${port}/   ← スマホからはこちら`);
    if (csvEnabled) {
      console.log(`  CSV      : ${path.relative(process.cwd(), roundsCsv)}`);
      console.log(`             ${path.relative(process.cwd(), calibCsv)}`);
    }
  });

  // テストから確実に落とせるようにする。server.close() だけでは既存接続が残る
  server.closeAll = () => new Promise((resolve) => {
    for (const room of rooms.values()) clearAllTimers(room);
    for (const c of wss.clients) c.terminate();
    wss.close(() => server.close(() => resolve()));
  });
  // Railway は停止時に SIGTERM を送る。接続を切ってから抜ける
  const shutdown = () => {
    console.log('shutting down');
    server.closeAll().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  if (!options.quiet) {
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  return server;
}
