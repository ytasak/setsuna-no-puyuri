// WebSocket 越しの結合テスト。core だけでなくアダプタ（遅延注入・接続管理）も通す。
// サーバーは同一プロセスで起動し、Node 組み込みの WebSocket クライアントで叩く。

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../adapters/node-ws.js';

const PORT = 8899 + (process.pid % 100);
const base = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = startServer({ port: PORT, csv: false, persist: false, quiet: true, cfg: { wMin: 60, wMax: 120, inputDeadline: 600 } });
test.after(() => server.closeAll());

class Bot {
  constructor(room, name, query = '') {
    this.name = name;
    this.ws = new WebSocket(`${base}/?room=${room}&mode=duel&name=${name}${query}`);
    this.plan = null; this.result = null; this.matchId = null;
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'WELCOME') this.id = m.clientId;
      if (m.type === 'MATCHED') this.matchId = m.matchId;
      if (m.type === 'ARMED') {
        this.roundId = m.roundId; this.result = null;
        if (this.plan?.flyAt != null) setTimeout(() => this.fly(), this.plan.flyAt);
      }
      if (m.type === 'SPING') this.send({ type: 'SPONG', seq: m.seq }); // サーバーのRTT計測に応答
      if (m.type === 'GO') this.onGo();
      if (m.type === 'RESULT') this.result = m;
    });
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ matchId: this.matchId, ...o })); }
  ready() { this.send({ type: 'READY' }); }
  fly() { this.send({ type: 'TAP', roundId: this.roundId, flying: true, rtt: { median: 1 } }); }
  onGo() {
    const p = this.plan;
    if (!p || p.flyAt != null) return;
    if (p.disconnect != null) { setTimeout(() => this.ws.close(), p.disconnect); return; }
    if (p.silent) return;
    setTimeout(() => this.send({
      type: 'TAP', roundId: this.roundId, flying: false, R: p.claim ?? p.tapAt,
      recvToPaint: 2, inputToHandler: 0.5, frameInterval: 16.7,
      visibilityOk: p.visibilityOk !== false, forged: p.claim != null,
      rtt: { median: p.fakeRtt ?? 1, p95: 2, jitter: 0.3 },
    }), p.tapAt);
  }
}
const waitOpen = (b) => new Promise((r) => b.ws.addEventListener('open', r, { once: true }));

async function round(a, b, planA, planB) {
  a.plan = planA; b.plan = planB; a.result = b.result = null;
  a.ready(); b.ready();
  for (let i = 0; i < 200; i++) { if (a.result || b.result) break; await sleep(50); }
  return a.result || b.result;
}
const who = (res, id) => res.players.find((p) => p.id === id);

let a, b;
test('接続とマッチング', async () => {
  a = new Bot('e2e', 'A'); b = new Bot('e2e', 'B');
  await Promise.all([waitOpen(a), waitOpen(b)]);
  await sleep(600);
  assert.ok(a.matchId, 'MATCHED を受け取る');
  assert.equal(a.matchId, b.matchId, '同じ matchId になる');
});

const cases = [
  ['正常: 反応が速い側の勝ち', { tapAt: 180 }, { tapAt: 220 }, (r, id) => assert.equal(who(r, id).result, 'win')],
  ['同着', { tapAt: 200 }, { tapAt: 210 }, (r, id) => assert.equal(who(r, id).result, 'draw')],
  ['片方フライング', { flyAt: 10 }, { tapAt: 200 }, (r, id) => assert.equal(who(r, id).result, 'lose')],
  ['双方フライング', { flyAt: 10 }, { flyAt: 20 }, (r, id) => assert.equal(who(r, id).result, 'draw')],
  ['片方無入力', { silent: true }, { tapAt: 200 }, (r, id) => assert.equal(who(r, id).result, 'lose')],
  ['双方無入力', { silent: true }, { silent: true }, (r, id) => assert.equal(who(r, id).result, 'draw')],
  ['R=50ms は予測入力として負け', { tapAt: 50 }, { tapAt: 300 }, (r, id) => assert.equal(who(r, id).result, 'lose')],
  // 既知の限界。整合性検査を外したので、一貫した偽造は通る（E' の決定）
  ['申告値はそのまま採用される', { tapAt: 400, claim: 150 }, { tapAt: 300 }, (r, id) => {
    assert.equal(who(r, id).R, 150);
    assert.equal(who(r, id).result, 'win');
  }],
  ['R_min 未満は弾かれる', { tapAt: 60, claim: 60 }, { tapAt: 300 }, (r, id) => {
    assert.equal(who(r, id).result, 'lose');
  }],
  ['正常ラウンドは記録される', { tapAt: 180 }, { tapAt: 250 }, (r) => assert.equal(r.recorded, true)],
];

for (const [name, pa, pb, check] of cases) {
  test(name, async () => {
    const r = await round(a, b, pa, pb);
    assert.ok(r, 'RESULT が届く');
    check(r, a.id);
    await sleep(150);
  });
}

test('人工遅延を入れても申告値で判定される（回線差に影響されない）', async () => {
  const c = new Bot('e2e-delay', 'C');
  const d = new Bot('e2e-delay', 'D', '&delayUp=60&delayDown=60');
  await Promise.all([waitOpen(c), waitOpen(d)]);
  await sleep(1500); // サーバーが自分で RTT を測るまで待つ
  const r = await round(c, d, { tapAt: 250 }, { tapAt: 180 });
  assert.ok(r);
  assert.equal(who(r, d.id).result, 'win', 'RTT 120ms 側でも申告値が速ければ勝つ');
  assert.ok(who(r, d.id).serverElapsed > who(r, c.id).serverElapsed,
    'サーバー受信順なら負けていたはず（方式B を棄却した根拠）');
  c.ws.close(); d.ws.close();
});

test('GO後の切断は残った側の不戦勝', async () => {
  const e = new Bot('e2e-dc', 'E'); const f = new Bot('e2e-dc', 'F');
  await Promise.all([waitOpen(e), waitOpen(f)]);
  await sleep(600);
  const r = await round(e, f, { disconnect: 50 }, { tapAt: 400 });
  assert.ok(r);
  assert.equal(r.players.find((p) => p.name === 'F').result, 'win');
  f.ws.close();
});

test('第三者はルームに入れない', async () => {
  const g = new Bot('e2e', 'G');
  const closed = await new Promise((r) => {
    g.ws.addEventListener('message', (ev) => {
      if (JSON.parse(ev.data).type === 'FULL') r(true);
    });
    setTimeout(() => r(false), 1500);
  });
  assert.equal(closed, true, '定員超過は FULL で拒否される');
  a.ws.close(); b.ws.close();
});
