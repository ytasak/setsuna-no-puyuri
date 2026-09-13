// 日次戦績・ランキング・待機列のテスト。
// 時計は固定して渡すので、日付をまたぐ挙動も実時間を待たずに検証できる。

import test from 'node:test';
import assert from 'node:assert/strict';
import { gameDate, nextReset, msUntilReset } from './clock.js';
import { nickname } from './nickname.js';
import { createStats } from './stats.js';
import { pickPair, isEngaged } from './lobby.js';

// ---------------------------------------------------------------- ゲーム日

test('ゲーム日は JST の暦日', () => {
  assert.equal(gameDate(new Date('2026-09-13T14:59:59Z')), '2026-09-13'); // JST 23:59:59
  assert.equal(gameDate(new Date('2026-09-13T15:00:00Z')), '2026-09-14'); // JST 翌 00:00
  assert.equal(gameDate(new Date('2026-09-13T00:00:00Z')), '2026-09-13'); // JST 09:00
});

test('次のリセットは JST の 00:00', () => {
  const now = new Date('2026-09-13T14:00:00Z'); // JST 23:00
  assert.equal(nextReset(now).toISOString(), '2026-09-13T15:00:00.000Z');
  assert.equal(msUntilReset(now), 60 * 60 * 1000);
});

// ---------------------------------------------------------------- 二つ名

test('二つ名は同じ日なら同じ、日が変われば変わる', () => {
  assert.equal(nickname('t1', '2026-09-13'), nickname('t1', '2026-09-13'));
  assert.notEqual(nickname('t1', '2026-09-13'), nickname('t1', '2026-09-14'));
});

test('二つ名に token が混ざらない', () => {
  const t = 'a0d4e1f2-3b4c-5d6e-7f80-912345678901';
  assert.ok(!nickname(t, '2026-09-13').includes(t.slice(0, 8)));
});

// ---------------------------------------------------------------- 戦績

const AT = new Date('2026-09-13T03:00:00Z'); // JST 12:00
const tokenOf = (id) => ({ a: 'tokA', b: 'tokB' }[id]);

function round(n, aRes, bRes, opts = {}) {
  return {
    resultId: `m${n}:1`, recorded: opts.recorded !== false,
    players: [
      { id: 'a', result: aRes, R: opts.aR ?? 200, Rsource: opts.aSrc ?? 'claimed',
        flying: false, tooFast: false, noInput: false, disconnected: false },
      { id: 'b', result: bRes, R: opts.bR ?? 250, Rsource: 'claimed',
        flying: false, tooFast: false, noInput: false, disconnected: false },
    ],
  };
}

test('勝敗が集計され、最速記録が更新される', () => {
  const s = createStats();
  s.record(round(1, 'win', 'lose', { aR: 210 }), tokenOf, AT);
  s.record(round(2, 'win', 'lose', { aR: 180 }), tokenOf, AT);
  const d = s.daily('tokA', AT);
  assert.equal(d.win, 2); assert.equal(d.games, 2);
  assert.equal(d.bestR, 180);
  assert.equal(d.streak, 2); assert.equal(d.bestStreak, 2);
});

test('同じ resultId の再送で戦績が増えない', () => {
  const s = createStats();
  s.record(round(1, 'win', 'lose'), tokenOf, AT);
  const again = s.record(round(1, 'win', 'lose'), tokenOf, AT);
  assert.equal(again.duplicate, true);
  assert.equal(s.daily('tokA', AT).games, 1);
});

test('記録されない試合は集計されず、連勝も切れない', () => {
  const s = createStats();
  s.record(round(1, 'win', 'lose'), tokenOf, AT);
  s.record(round(2, 'lose', 'win', { recorded: false }), tokenOf, AT); // 無効試合
  const d = s.daily('tokA', AT);
  assert.equal(d.win, 1);
  assert.equal(d.lose, 0, '無効試合は負けに数えない');
  assert.equal(d.voided, 1);
  assert.equal(d.streak, 1, '無効試合で連勝は切れない');
});

test('引き分けでは連勝が切れず、増えもしない', () => {
  const s = createStats();
  s.record(round(1, 'win', 'lose'), tokenOf, AT);
  s.record(round(2, 'draw', 'draw'), tokenOf, AT);
  s.record(round(3, 'win', 'lose'), tokenOf, AT);
  const d = s.daily('tokA', AT);
  assert.equal(d.streak, 2);
  assert.equal(d.draw, 1);
});

test('負けで連勝が切れ、最長連勝は残る', () => {
  const s = createStats();
  for (const n of [1, 2, 3]) s.record(round(n, 'win', 'lose'), tokenOf, AT);
  s.record(round(4, 'lose', 'win'), tokenOf, AT);
  const d = s.daily('tokA', AT);
  assert.equal(d.streak, 0);
  assert.equal(d.bestStreak, 3);
});

test('負けた試合でも最速記録は更新される', () => {
  const s = createStats();
  s.record(round(1, 'lose', 'win', { aR: 150, bR: 140 }), tokenOf, AT);
  assert.equal(s.daily('tokA', AT).bestR, 150, '負けても速ければ記録になる');
});

test('差し替えられた申告値は最速記録に入らない', () => {
  const s = createStats();
  s.record(round(1, 'win', 'lose', { aR: 90, aSrc: 'server-estimate', recorded: false }), tokenOf, AT);
  assert.equal(s.daily('tokA', AT).bestR, null);
});

// ---------------------------------------------------------------- ランキング

test('ランキングは最速昇順・連勝降順で、token を出さない', () => {
  const s = createStats();
  const many = (id) => (x) => ({ a: id, b: 'other' }[x]);
  s.record(round(1, 'win', 'lose', { aR: 220 }), many('t1'), AT);
  s.record(round(2, 'win', 'lose', { aR: 170 }), many('t2'), AT);
  s.record(round(3, 'win', 'lose', { aR: 195 }), many('t3'), AT);
  const r = s.ranking(AT);
  assert.deepEqual(r.fastest.map((x) => x.value), [170, 195, 220, 250]);
  assert.ok(r.fastest.every((x) => !JSON.stringify(x).includes('t1')));
  assert.ok(r.streak.every((x) => typeof x.value === 'number'));
  assert.equal(r.date, '2026-09-13');
});

test('同点は先に記録した方が上', () => {
  const s = createStats();
  const at1 = new Date('2026-09-13T03:00:00Z');
  const at2 = new Date('2026-09-13T04:00:00Z');
  s.record(round(1, 'win', 'lose', { aR: 200 }), (x) => ({ a: 'early', b: 'z1' }[x]), at1);
  s.record(round(2, 'win', 'lose', { aR: 200 }), (x) => ({ a: 'late', b: 'z2' }[x]), at2);
  const r = s.ranking(at2);
  const names = r.fastest.filter((x) => x.value === 200).map((x) => x.name);
  assert.equal(names[0], nickname('early', '2026-09-13'));
});

test('日付が変わるとランキングが空になる', () => {
  const s = createStats();
  s.record(round(1, 'win', 'lose'), tokenOf, new Date('2026-09-13T03:00:00Z'));
  const next = new Date('2026-09-14T03:00:00Z');
  assert.equal(s.ranking(next).fastest.length, 0, 'ゲーム日でスコープされるので見えない');
  assert.equal(s.daily('tokA', next).games, 0);
  assert.equal(s.daily('tokA', new Date('2026-09-13T03:00:00Z')).games, 1, '当日ぶんは残っている');
});

test('prune は容量回収だけで、当日の記録は残す', () => {
  const s = createStats();
  s.record(round(1, 'win', 'lose'), tokenOf, new Date('2026-09-13T03:00:00Z'));
  s.record(round(2, 'win', 'lose'), tokenOf, new Date('2026-09-14T03:00:00Z'));
  s.prune(new Date('2026-09-14T03:00:00Z'));
  assert.deepEqual(s.dates, ['2026-09-14']);
});

// ---------------------------------------------------------------- 待機列

test('token が異なる2人を組む', () => {
  assert.deepEqual(pickPair([{ token: 'x' }, { token: 'y' }]), [0, 1]);
});

test('同じ token 同士は組まない（複数タブでの自己対戦を防ぐ）', () => {
  assert.equal(pickPair([{ token: 'x' }, { token: 'x' }]), null);
  assert.deepEqual(pickPair([{ token: 'x' }, { token: 'x' }, { token: 'y' }]), [0, 2],
    '同一 token は飛ばして次の相手と組む');
});

test('1人だけなら組まない', () => {
  assert.equal(pickPair([{ token: 'x' }]), null);
  assert.equal(pickPair([]), null);
});

test('既に所属している token は二重に入れない', () => {
  assert.equal(isEngaged('x', { queue: [{ token: 'x' }] }), true);
  assert.equal(isEngaged('x', { engagedTokens: new Set(['x']) }), true);
  assert.equal(isEngaged('x', { queue: [{ token: 'y' }] }), false);
});
