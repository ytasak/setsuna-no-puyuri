// 戦績の永続化（SET2-9）。
//
// 見たいのは1点だけ ——「サーバーを落として起こし直しても、その日の記録が残っているか」。
// 保存層単体の往復と、実際にサーバーを再起動する結合の両方で確かめる。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startServer } from '../adapters/node-ws.js';
import { openStatsStore } from '../adapters/stats-store.js';
import { gameDate } from '../core/clock.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'puyuri-persist-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 保存層だけ

test('閉じて開き直しても、保存した行がそのまま読める', () => {
  const dir = tmp();
  const file = path.join(dir, 'stats.db');
  const row = {
    date: '2026-09-13', token: 'tok-1', name: '宵闇のぷゆ庵',
    games: 3, win: 2, lose: 1, draw: 0, voided: 0,
    bestR: 177.4, bestRAt: '2026-09-13T03:00:00.000Z',
    streak: 2, bestStreak: 2, bestStreakAt: '2026-09-13T03:00:00.000Z',
  };

  const a = openStatsStore(file);
  a.save(row);
  a.close();

  const b = openStatsStore(file);
  assert.deepEqual(b.load('2026-09-13'), [row]);
  b.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('同じ (日付, token) は上書きされ、増えない', () => {
  const dir = tmp();
  const s = openStatsStore(path.join(dir, 'stats.db'));
  const base = { date: '2026-09-13', token: 'tok-1', name: 'ぷゆ', games: 1, win: 1, lose: 0, draw: 0, voided: 0, bestR: 200, bestRAt: 'x', streak: 1, bestStreak: 1, bestStreakAt: 'x' };
  s.save(base);
  s.save({ ...base, games: 2, win: 2, bestR: 150, streak: 2, bestStreak: 2 });

  const rows = s.load('2026-09-13');
  assert.equal(rows.length, 1, '行が増えている');
  assert.equal(rows[0].games, 2);
  assert.equal(rows[0].bestR, 150);
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('当日以外の行は掃除で消える', () => {
  const dir = tmp();
  const s = openStatsStore(path.join(dir, 'stats.db'));
  const row = (date, token) => ({ date, token, name: 'ぷゆ', games: 1, win: 1, lose: 0, draw: 0, voided: 0, bestR: null, bestRAt: null, streak: 1, bestStreak: 1, bestStreakAt: null });
  s.save(row('2026-09-12', 'old'));
  s.save(row('2026-09-13', 'new'));

  s.prune('2026-09-13');
  assert.equal(s.load('2026-09-12').length, 0);
  assert.equal(s.load('2026-09-13').length, 1);
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bestR が null でも往復する', () => {
  const dir = tmp();
  const file = path.join(dir, 'stats.db');
  const row = { date: '2026-09-13', token: 't', name: 'ぷゆ', games: 1, win: 0, lose: 0, draw: 0, voided: 1, bestR: null, bestRAt: null, streak: 0, bestStreak: 0, bestStreakAt: null };
  const a = openStatsStore(file); a.save(row); a.close();
  const b = openStatsStore(file);
  assert.deepEqual(b.load('2026-09-13'), [row]);
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('開けない場所を渡しても例外にならず、保存しない版になる', () => {
  // ディレクトリとして作れないパス（既存ファイルの下）を指す
  const dir = tmp();
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');

  const warnings = [];
  const s = openStatsStore(path.join(blocker, 'stats.db'), { log: (m) => warnings.push(m) });

  assert.equal(s.ok, false);
  assert.doesNotThrow(() => s.save({ date: 'd', token: 't' }), '保存の失敗で落ちてはいけない');
  assert.deepEqual(s.load('d'), []);
  assert.equal(warnings.length, 1, '警告は1回だけ');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('保存を切れば書き込みもファイル作成も起きない', () => {
  const dir = tmp();
  const s = openStatsStore(path.join(dir, 'stats.db'), { enabled: false });
  s.save({ date: 'd', token: 't' });
  assert.equal(s.ok, false);
  assert.deepEqual(fs.readdirSync(dir), [], 'ファイルが作られている');
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('起動と落ちた理由が再起動をまたいで残る', () => {
  const dir = tmp();
  const file = path.join(dir, 'stats.db');

  const a = openStatsStore(file);
  a.note('boot', 'pid=1');
  a.note('crash', 'TypeError: x is not a function');
  a.close();

  // プロセスが死んでも、次に立ち上がったときに前回の落ち方が読める
  const b = openStatsStore(file);
  const rows = b.recent(5);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'crash', '新しい順に並ぶ');
  assert.match(rows[0].detail, /TypeError/);
  assert.equal(rows[1].kind, 'boot');
  b.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('診断の記録に失敗しても本体は落ちない', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const s = openStatsStore(path.join(blocker, 'stats.db'), { log: () => {} });

  // 落ちる直前に呼ばれるので、ここで投げるとクラッシュ処理ごと巻き込む
  assert.doesNotThrow(() => s.note('crash', 'なにか'));
  assert.deepEqual(s.recent(5), []);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 再起動をまたぐ

const PORT = 8999 + (process.pid % 100);

/**
 * lab の duel モードで1試合だけ終わらせる。
 * MATCHED は接続直後に飛んでくるので、受信ハンドラは open を待つ前に付けておく。
 */
async function playOneRound(port, tapMs = [180, 240]) {
  const url = `ws://127.0.0.1:${port}/?room=persist&mode=duel&name=`;
  const bots = await Promise.all(['A', 'B'].map((name, i) => new Promise((resolve) => {
    const ws = new WebSocket(url + name);
    const st = { ws, matchId: null, roundId: null, result: null };
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'MATCHED') st.matchId = m.matchId;
      if (m.type === 'ARMED') st.roundId = m.roundId;
      if (m.type === 'SPING') ws.send(JSON.stringify({ type: 'SPONG', seq: m.seq, matchId: st.matchId }));
      if (m.type === 'GO') {
        setTimeout(() => ws.send(JSON.stringify({
          type: 'TAP', matchId: st.matchId, roundId: st.roundId, flying: false,
          R: tapMs[i], recvToPaint: 2, inputToHandler: 0.5,
          frameInterval: 16.7, visibilityOk: true, rtt: { median: 1, p95: 2, jitter: 0.3 },
        })), tapMs[i]);
      }
      if (m.type === 'RESULT') st.result = m;
    });
    ws.addEventListener('open', () => resolve(st), { once: true });
  })));

  // 2人そろって MATCHED を受け取るまで待つ
  for (let i = 0; i < 60 && !bots.every((b) => b.matchId); i++) await sleep(50);
  bots.forEach((b) => b.ws.send(JSON.stringify({ type: 'READY', matchId: b.matchId })));
  for (let i = 0; i < 200 && !bots.every((b) => b.result); i++) await sleep(50);

  const result = bots[0].result;
  bots.forEach((b) => b.ws.close());
  await sleep(50);
  return result;
}

/** listen が済むまで待つ。startServer は待たずに返るので、すぐ叩くと接続を切られる */
async function start(options) {
  const server = startServer(options);
  if (!server.listening) await once(server, 'listening');
  return server;
}

const ranking = async (port) =>
  (await fetch(`http://127.0.0.1:${port}/api/ranking`)).json();

test('サーバーを再起動しても、その日のランキングが残る', async () => {
  const dir = tmp();

  const first = await start({ port: PORT, csv: false, quiet: true, dataDir: dir, cfg: { wMin: 60, wMax: 120 } });
  const result = await playOneRound(PORT);
  assert.ok(result, '1試合が確定していない');

  const before = await ranking(PORT);
  assert.equal(before.date, gameDate());
  assert.equal(before.players, 2, '2人ぶん記録されていない');
  assert.equal(before.fastest.length, 2);
  await first.closeAll();

  // 同じ保存先で起こし直す
  const second = await start({ port: PORT, csv: false, quiet: true, dataDir: dir, cfg: { wMin: 60, wMax: 120 } });
  const after = await ranking(PORT);
  await second.closeAll();

  assert.deepEqual(after, before, '再起動でランキングが変わっている');
  assert.equal(after.fastest[0].value, 180, '最速が残っていない');

  // token は外に出さない（SET2-6 §6.4）。保存が入っても変わらないこと
  assert.equal(JSON.stringify(after).includes('token'), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('保存を切って起こし直すと、記録は引き継がれない', async () => {
  const dir = tmp();
  const port = PORT + 1;

  const first = await start({ port, csv: false, quiet: true, dataDir: dir, cfg: { wMin: 60, wMax: 120 } });
  await playOneRound(port);
  assert.equal((await ranking(port)).players, 2);
  await first.closeAll();

  const second = await start({ port, csv: false, quiet: true, dataDir: dir, persist: false, cfg: { wMin: 60, wMax: 120 } });
  assert.equal((await ranking(port)).players, 0);
  await second.closeAll();

  fs.rmSync(dir, { recursive: true, force: true });
});
