// Node の HTTP アダプタ。
//
// 持っているのは静的配信と、当日の記録のための口だけ。
// 試合はブラウザの中で完結するので、**サーバーは勝ち負けを判定しない**。
// 届いた結果をその日の集計に足すだけで、値を確かめる術は無い
// （docs/set2-4-sync-fairness.md §5.3）。
//
// 判定規則（core/match.js）は /core/match.js としてブラウザへ配る。
// 書き写すと本物と食い違うので、実体は1つに保つ。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStats } from '../core/stats.js';
import { openStatsStore } from './stats-store.js';
import { gameDate, msUntilReset } from '../core/clock.js';
import { nickname } from '../core/nickname.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// Railway では Volume のマウント先をここに向ける。指定が無ければリポジトリ内の data/
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

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

// ---------------------------------------------------------------- 受け取り

/**
 * POST の本文を JSON として読む。壊れていれば null を返す。
 *
 * 公開エンドポイントなので上限を置く。1ラウンドぶんは 200 バイトにも満たないので
 * 8KB あれば充分すぎる。超えたら読むのをやめて接続を捨てる。
 */
function readJson(req, cb, limit = 8 * 1024) {
  const chunks = [];
  let size = 0, done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { finish(null); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { finish(JSON.parse(Buffer.concat(chunks).toString())); } catch { finish(null); }
  });
  req.on('error', () => finish(null));
}

/**
 * 届いた1ラウンドを、記録できる形に整えて返す。受け付けられなければ null。
 *
 * **これは不正対策ではない。** 値はクライアントの申告そのままで、確かめる術はない
 * （docs/set2-4-sync-fairness.md §5.3）。壊れた値で集計を壊さないための型の検査だけをする。
 */
function normalizeRound(body) {
  if (!body || typeof body !== 'object') return null;
  // 二重記録を防ぐためだけの使い捨ての id。連番にすると、
  // ページを開き直したときに以前のラウンドと同じ id になって捨てられる
  const id = body.id;
  if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{8,64}$/.test(id)) return null;
  if (body.result !== 'win' && body.result !== 'lose') return null;
  const R = typeof body.R === 'number' && Number.isFinite(body.R) && body.R >= 0 && body.R < 60000
    ? body.R : null;
  return { id, result: body.result, R, flying: !!body.flying, noInput: !!body.noInput };
}

// ---------------------------------------------------------------- 起動

export function startServer(options = {}) {
  const port = num(process.env.PORT, options.port ?? 8787);
  // 書き込み先。テストは一時ディレクトリを渡す
  const dataDir = options.dataDir ?? DATA_DIR;

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  };
  // Railway など TLS 終端の後ろに置かれる場合、req 自体は平文で届く。
  // 環境変数の設定漏れで Cookie の属性が落ちると iOS Safari で identity が保てないので、
  // x-forwarded-proto も見て自動で判断する。
  const forceSecure = process.env.COOKIE_SECURE === '1';
  const isSecure = (req) => forceSecure || req.headers['x-forwarded-proto'] === 'https';
  // 戦績の保存。開けなければ黙ってメモリだけで動く（adapters/stats-store.js）
  const store = openStatsStore(path.join(dataDir, 'stats.db'), {
    enabled: options.persist !== false && process.env.PERSIST !== '0',
  });
  const stats = createStats({ onChange: (s) => store.save(s) });
  const restored = stats.restore(store.load(gameDate()));

  // 起動と異常終了を Volume に書き残す。Railway のログを見られなくても、
  // 「いつ起動して、なぜ落ちたか」が /api/health から読める。
  //
  // 落ちる直前の記録を残したいので、握りつぶして動かし続けることはしない。
  // 状態が壊れたまま走り続けるほうが危ない。記録だけ残して終了し、Railway に再起動させる。
  const startedAt = Date.now();
  store.note('boot', `pid=${process.pid} node=${process.version}`);
  const die = (kind) => (err) => {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    store.note(kind, detail);
    console.error(`[${kind}]`, detail);
    try { store.close(); } catch { /* 閉じられなくても終了は続ける */ }
    process.exit(1);
  };
  // テスト（quiet）では入れない。プロセス全体のハンドラなので、
  // テストランナーの例外まで拾って process.exit してしまう
  if (!options.quiet && options.trapCrashes !== false) {
    process.on('uncaughtException', die('crash'));
    process.on('unhandledRejection', die('rejection'));
  }

  setInterval(() => {
    const keep = gameDate();
    stats.prune();
    store.prune(keep);
  }, 60 * 60 * 1000).unref?.();

  /** 本人向けでも token は返さない */
  const publicDaily = (d) => ({
    name: d.name, games: d.games, win: d.win, lose: d.lose, draw: d.draw, voided: d.voided,
    bestR: d.bestR === null ? null : Math.round(d.bestR), streak: d.streak, bestStreak: d.bestStreak,
  });

  /** ページが必要とする「自分まわり」を一式返す。token は出さない */
  const mePayload = (token, cookieReceived) => ({
    you: nickname(token, gameDate()),       // その日限りの二つ名
    cookieReceived,                         // false が続くなら記録が残らない
    daily: publicDaily(stats.daily(token)),
    ranking: stats.ranking(),
    msUntilReset: msUntilReset(),
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // どのレスポンスでも Cookie を書き直して有効期限をスライドさせる
    const token = readToken(req) ?? randomUUID();
    const headers = { 'set-cookie': cookieHeader(token, isSecure(req)), 'cache-control': 'no-store' };

    // 判定規則をブラウザへ配る。判定を二重に書くと本物と食い違うため。
    // 固定パスなので、ユーザー入力がファイルパスに入る余地は無い
    if (url.pathname === '/core/match.js') {
      res.writeHead(200, { ...headers, 'content-type': MIME['.js'] });
      fs.createReadStream(path.join(ROOT, 'core', 'match.js')).pipe(res);
      return;
    }

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // persist は「戦績が残る状態か」。Volume のマウント漏れや書き込み失敗を
      // ログを見にいかずに確かめられるようにしておく（書き込みが一度でも失敗すると false になる）
      res.end(JSON.stringify({
        ok: true, date: gameDate(), persist: store.ok,
        // 再起動の頻度と落ちた理由を、ログを見ずに追えるようにしておく
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        recent: store.recent(8),
      }));
      return;
    }

    // 当日の自分の記録と最速ランキング。ページを開いたときと、記録した直後に取る
    if (url.pathname === '/api/me') {
      res.writeHead(200, { ...headers, 'content-type': MIME['.json'] });
      res.end(JSON.stringify(mePayload(token, readToken(req) !== null)));
      return;
    }

    // 1ラウンドぶんを当日の記録に取り込む。返すのは /api/me と同じ形
    if (url.pathname === '/api/result') {
      if (req.method !== 'POST') { res.writeHead(405, headers); res.end(); return; }
      readJson(req, (body) => {
        const round = normalizeRound(body);
        if (!round) { res.writeHead(400, { ...headers, 'content-type': MIME['.json'] }); res.end('{"ok":false}'); return; }
        stats.record({
          // token で名前空間を分ける。分けないと、別の人のラウンドと
          // 同じ resultId になって二重記録の防止に引っかかり、片方が捨てられる
          resultId: `${token}:${round.id}`,
          recorded: true,
          players: [{
            id: 'me', result: round.result, R: round.R,
            flying: round.flying, tooFast: false, noInput: round.noInput, disconnected: false,
          }],
        }, () => token);
        res.writeHead(200, { ...headers, 'content-type': MIME['.json'] });
        res.end(JSON.stringify(mePayload(token, readToken(req) !== null)));
      });
      return;
    }

    // 当日の全体集計。合計しか出さないので、誰がどうだったかは分からない
    if (url.pathname === '/api/summary') {
      res.writeHead(200, { ...headers, 'content-type': MIME['.json'] });
      res.end(JSON.stringify(stats.summary()));
      return;
    }

    if (url.pathname === '/api/ranking') {
      res.writeHead(200, { ...headers, 'content-type': MIME['.json'] });
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

  if (options.quiet) console.log = () => {};
  server.listen(port, () => {
    const addrs = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log('刹那のぷゆり');
    console.log(`  ローカル : http://localhost:${port}/`);
    for (const a of addrs) console.log(`  LAN      : http://${a}:${port}/   ← スマホからはこちら`);
    console.log(store.ok
      ? `  戦績     : ${path.join(dataDir, 'stats.db')}（当日 ${restored} 人ぶんを復元）`
      : '  戦績     : 保存しない（メモリのみ。再起動で消える）');
  });

  // テストから確実に落とせるようにする。close() だけでは keep-alive の接続が残る
  server.closeAll = () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => { store.close(); resolve(); });
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
