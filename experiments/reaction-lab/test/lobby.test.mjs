// Cookie identity と待機列の結合テスト。
// Cookie ヘッダを付けて接続する必要があるので、ブラウザ相当の WebSocket ではなく
// ws のクライアントを使う。

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../adapters/node-ws.js';

const PORT = 9100 + (process.pid % 300);
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = startServer({ port: PORT, csv: false, quiet: true, cfg: { wMin: 60, wMax: 120 } });
test.after(() => server.closeAll());

function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?mode=queue`, {
    headers: token ? { cookie: `puyuri_token=${token}` } : {},
  });
  const msgs = [];
  ws.on('error', () => {}); // クライアント側も受けておく
  ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
  const seen = (type) => msgs.find((m) => m.type === type);
  return {
    ws, msgs, seen,
    open: () => new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
  };
}
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------- Cookie

test('Cookie が発行され、iframe 用の属性が付く', async () => {
  const res = await fetch(`${base}/game.html`);
  const sc = res.headers.get('set-cookie') ?? '';
  assert.match(sc, /puyuri_token=[0-9a-f-]{36}/, 'UUID が入る');
  assert.match(sc, /HttpOnly/, 'JS から読めない');
  assert.match(sc, /Max-Age=2592000/, '約30日');
  assert.match(sc, /Path=\//);
});

test('既定は平文 http 用に SameSite=Lax', async () => {
  const res = await fetch(`${base}/game.html`);
  const sc = res.headers.get('set-cookie') ?? '';
  assert.match(sc, /SameSite=Lax/);
  assert.ok(!/Partitioned/.test(sc));
});

test('COOKIE_SECURE=1 なら Secure + SameSite=None + Partitioned が付く', async () => {
  // Partitioned が要。SameSite=None だけでは iOS Safari など
  // サードパーティ Cookie 遮断下で保存されず、毎回別人が作られる
  const prev = process.env.COOKIE_SECURE;
  process.env.COOKIE_SECURE = '1';
  const port = PORT + 1;
  const secureServer = startServer({ port, csv: false, quiet: true });
  try {
    await sleep(200);
    const res = await fetch(`http://127.0.0.1:${port}/game.html`);
    const sc = res.headers.get('set-cookie') ?? '';
    assert.match(sc, /Secure/);
    assert.match(sc, /SameSite=None/);
    assert.match(sc, /Partitioned/, 'Partitioned を落とすと iOS Safari で identity が保てない');
  } finally {
    await secureServer.closeAll();
    if (prev === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = prev;
  }
});

test('Cookie を送れば同じ token として扱われ、送らなければ都度別人になる', async () => {
  const a1 = connect(UUID_A); await a1.open(); await sleep(120);
  const a2 = connect(UUID_A); await a2.open(); await sleep(120);
  const n1 = connect(null);   await n1.open(); await sleep(120);
  const n2 = connect(null);   await n2.open(); await sleep(120);

  assert.equal(a1.seen('WELCOME').cookieReceived, true);
  assert.equal(n1.seen('WELCOME').cookieReceived, false, 'Cookie 無しは検出できる');
  assert.equal(a1.seen('WELCOME').you, a2.seen('WELCOME').you, '同じ token なら同じ二つ名');
  assert.notEqual(n1.seen('WELCOME').you, n2.seen('WELCOME').you, 'Cookie 無しは毎回別人');
  for (const c of [a1, a2, n1, n2]) c.close();
  await sleep(120);
});

test('二つ名に token が混ざらない', async () => {
  const c = connect(UUID_A); await c.open(); await sleep(120);
  assert.ok(!c.seen('WELCOME').you.includes('1111'));
  c.close(); await sleep(100);
});

// ---------------------------------------------------------------- 待機列

test('同じ token 同士はマッチしない（複数タブでの自己対戦を防ぐ）', async () => {
  const t1 = connect(UUID_A); const t2 = connect(UUID_A);
  await Promise.all([t1.open(), t2.open()]); await sleep(150);
  t1.send({ type: 'JOIN' });
  await sleep(150);
  t2.send({ type: 'JOIN' });
  await sleep(400);

  assert.ok(t1.seen('QUEUED'), '1つ目は待機列に入る');
  assert.ok(t2.seen('QUEUE_REJECTED'), '2つ目は同じ token なので拒否される');
  assert.equal(t1.seen('MATCHED'), undefined, '自分自身とはマッチしない');
  t1.close(); t2.close(); await sleep(150);
});

test('token が異なる2人はマッチする', async () => {
  const a = connect(UUID_A); const b = connect(UUID_B);
  await Promise.all([a.open(), b.open()]); await sleep(150);
  a.send({ type: 'JOIN' }); await sleep(120);
  b.send({ type: 'JOIN' }); await sleep(400);

  const ma = a.seen('MATCHED'), mb = b.seen('MATCHED');
  assert.ok(ma && mb, '両者に MATCHED が届く');
  assert.equal(ma.matchId, mb.matchId, '同じルーム');
  assert.equal(ma.peer[0], mb.you, '相手の二つ名が見える');
  assert.ok(!JSON.stringify(ma).includes(UUID_B), 'token は渡さない');
  a.close(); b.close(); await sleep(150);
});

test('待機中に切断すると列から外れ、残った人は次の相手と組める', async () => {
  const a = connect(UUID_A); await a.open(); await sleep(120);
  a.send({ type: 'JOIN' }); await sleep(200);
  a.close(); await sleep(250);

  const b = connect(UUID_B); const c = connect(UUID_A);
  await Promise.all([b.open(), c.open()]); await sleep(150);
  b.send({ type: 'JOIN' }); await sleep(120);
  c.send({ type: 'JOIN' }); await sleep(400);
  assert.ok(b.seen('MATCHED'), '取り残された待機が解消されている');
  b.close(); c.close(); await sleep(150);
});

// ---------------------------------------------------------------- 戦績

test('ランキング API は token を出さない', async () => {
  const res = await fetch(`${base}/api/ranking`);
  const body = await res.json();
  assert.ok(Array.isArray(body.fastest) && Array.isArray(body.streak));
  assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!JSON.stringify(body).includes(UUID_A));
  assert.ok(!JSON.stringify(body).includes('token'));
});

test('接続時に当日の戦績と残り時間が返る', async () => {
  const c = connect(UUID_B); await c.open(); await sleep(150);
  const w = c.seen('WELCOME');
  assert.equal(typeof w.daily.games, 'number');
  assert.equal(typeof w.daily.streak, 'number');
  assert.ok(w.msUntilReset > 0 && w.msUntilReset <= 24 * 3600 * 1000);
  assert.ok(!JSON.stringify(w.daily).includes(UUID_B), '本人向けでも token は返さない');
  c.close(); await sleep(100);
});

// ---------------------------------------------------------------- 受信サイズ

test('上限を超えるメッセージを送ってきた接続は閉じられ、サーバーは落ちない', async () => {
  const c = connect(UUID_A);
  await c.open(); await sleep(150);
  const closed = new Promise((r) => c.ws.on('close', (code) => r(code)));
  c.ws.send(JSON.stringify({ type: 'TAP', pad: 'x'.repeat(8 * 1024) }));
  const code = await Promise.race([closed, sleep(2000).then(() => null)]);
  assert.equal(code, 1009, 'メッセージが大きすぎるとして閉じる');

  // ハンドラが無いと 'error' が未処理例外になりプロセスごと落ちる
  await sleep(300);
  const after = await fetch(`${base}/api/ranking`);
  assert.equal(after.status, 200, 'サーバーは生きている');
});

test('通常のメッセージは上限に引っかからない', async () => {
  const c = connect(UUID_B);
  await c.open(); await sleep(150);
  c.send({ type: 'JOIN' });
  await sleep(250);
  assert.ok(c.seen('QUEUED'), '普通のやり取りは通る');
  assert.equal(c.ws.readyState, 1, '接続は生きている');
  c.close(); await sleep(100);
});
