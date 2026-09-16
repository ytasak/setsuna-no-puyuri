// Cookie identity と記録の口の結合テスト。
// Cookie ヘッダを自分で付けたいので、素の fetch で叩く。

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServer } from '../adapters/server.js';

const PORT = 9100 + (process.pid % 300);
const base = `http://127.0.0.1:${PORT}`;

const server = startServer({ port: PORT, persist: false, quiet: true });
test.after(() => server.closeAll());

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function call(path, { token, method = 'GET', body, port = PORT } = {}) {
  const headers = {};
  if (token) headers.cookie = `puyuri_token=${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}
const me = async (token) => (await call('/api/me', { token })).json();
const report = (token, body) => call('/api/result', { token, method: 'POST', body });
const round = (o = {}) => ({ id: randomUUID(), result: 'win', R: 200, ...o });

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
  const secure = startServer({ port, persist: false, quiet: true });
  try {
    const res = await call('/api/me', { port });
    const sc = res.headers.get('set-cookie') ?? '';
    assert.match(sc, /Secure/);
    assert.match(sc, /SameSite=None/);
    assert.match(sc, /Partitioned/);
  } finally {
    await secure.closeAll();
    if (prev === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = prev;
  }
});

test('Cookie を送れば同じ人、送らなければ都度別人になる', async () => {
  const a1 = await me(UUID_A);
  const a2 = await me(UUID_A);
  assert.equal(a1.you, a2.you, '同じ token なら同じ二つ名');
  assert.equal(a1.cookieReceived, true);

  const anon = await me();
  assert.equal(anon.cookieReceived, false, 'Cookie が届いていないことが分かる');
});

test('二つ名に token が混ざらない', async () => {
  const m = await me(UUID_A);
  assert.ok(!m.you.includes(UUID_A));
  assert.ok(!m.you.includes(UUID_A.slice(0, 8)));
});

test('接続時に当日の記録とリセットまでの残りが返る', async () => {
  const m = await me(randomUUID());
  assert.equal(m.daily.games, 0);
  assert.equal(m.daily.bestR, null);
  assert.ok(m.msUntilReset > 0 && m.msUntilReset <= 24 * 60 * 60 * 1000);
  assert.ok(Array.isArray(m.ranking.fastest));
});

// ---------------------------------------------------------------- 記録

test('結果を送ると当日の記録に入り、最速が更新される', async () => {
  const token = randomUUID();
  const first = await (await report(token, round({ R: 260 }))).json();
  assert.equal(first.daily.games, 1);
  assert.equal(first.daily.win, 1);
  assert.equal(first.daily.bestR, 260);

  const second = await (await report(token, round({ R: 210.4 }))).json();
  assert.equal(second.daily.games, 2);
  assert.equal(second.daily.bestR, 210, '速いほうに更新される');

  const third = await (await report(token, round({ R: 400 }))).json();
  assert.equal(third.daily.bestR, 210, '遅い試行では戻らない');
});

test('同じ id を二度送っても増えない', async () => {
  const token = randomUUID();
  const r = round({ R: 300 });
  await report(token, r);
  const again = await (await report(token, r)).json();
  assert.equal(again.daily.games, 1);
});

test('別の人が同じ id を送っても、互いの記録を潰さない', async () => {
  const id = randomUUID();
  const a = randomUUID(), b = randomUUID();
  const ra = await (await report(a, { id, result: 'win', R: 180 })).json();
  const rb = await (await report(b, { id, result: 'win', R: 190 })).json();
  assert.equal(ra.daily.games, 1);
  assert.equal(rb.daily.games, 1, '同じ id でも別人なら別の記録');
});

test('フライングと無入力は負けとして数えるが、最速記録には入れない', async () => {
  const token = randomUUID();
  await report(token, round({ result: 'lose', R: null, flying: true }));
  const m = await (await report(token, round({ result: 'lose', R: null, noInput: true }))).json();
  assert.equal(m.daily.games, 2);
  assert.equal(m.daily.lose, 2);
  assert.equal(m.daily.bestR, null, '合図の前や無入力のラウンドは最速に入らない');
});

test('壊れた本文は 400 で、記録は増えない', async () => {
  const token = randomUUID();
  for (const body of ['{', {}, { id: 'short' }, round({ result: 'draw' }), round({ id: 5 }), 'null']) {
    const res = await report(token, body);
    assert.equal(res.status, 400, `受け付けてしまった: ${JSON.stringify(body)}`);
  }
  assert.equal((await me(token)).daily.games, 0);
});

test('POST 以外では受け付けない', async () => {
  assert.equal((await call('/api/result')).status, 405);
});

test('上限を超える本文を送ってもサーバーは落ちない', async () => {
  const token = randomUUID();
  await report(token, JSON.stringify({ id: randomUUID(), result: 'win', R: 200, junk: 'x'.repeat(64 * 1024) }))
    .catch(() => {}); // 読むのをやめて接続を捨てるので、投げても構わない
  // まだ応答できること
  assert.equal((await me(token)).daily.games, 0);
});

// ---------------------------------------------------------------- 外に出さないもの

test('ランキング API は token を出さない', async () => {
  const token = randomUUID();
  await report(token, round({ R: 150 }));
  const res = await call('/api/ranking');
  const text = await res.text();
  assert.ok(!text.includes(token), 'token が漏れている');
  assert.ok(JSON.parse(text).fastest.length > 0);
});

test('判定規則がブラウザから読める', async () => {
  const res = await fetch(`${base}/core/match.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  assert.match(await res.text(), /export function decide/);
});
