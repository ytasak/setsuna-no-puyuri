// core/match.js のテスト。偽の時計で駆動するので実時間を待たない。
// 実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, STATE, TIMER } from './match.js';

const CFG = { wMin: 1000, wMax: 1000, inputDeadline: 3000, tieBand: 20, rMin: 100, eps: 80 };

function setup(players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]) {
  let t = 10_000;
  let goAt = null;
  const seq = { a: 0, b: 0, x: 0 };
  const m = createMatch({
    matchId: 'm1', players, cfg: CFG,
    now: () => t, random: () => 0, // w は常に wMin
  });
  const api = {
    m,
    advance: (ms) => { t += ms; },
    at: () => t,
    goAt: () => goAt,
    // GO から ms 経過した時点に時計を合わせる。累積ではなく絶対位置で置く
    setSinceGo: (ms) => { t = goAt + ms; },
    ready: (id) => m.handle({ type: 'READY', clientId: id, eventId: ++seq[id], matchId: 'm1' }),
    fireGo: () => { const c = m.handle({ type: 'TIMER', name: TIMER.GO }); goAt = t; return c; },
    fireDeadline: () => m.handle({ type: 'TIMER', name: TIMER.DEADLINE }),
    tap: (id, o = {}) => m.handle({
      type: 'TAP', clientId: id, eventId: o.eventId ?? ++seq[id],
      matchId: o.matchId ?? 'm1', roundId: o.roundId ?? m.round?.roundId ?? 1,
      flying: o.flying ?? false, R: o.R,
      rtt: o.rtt ?? { median: 10 }, visibilityOk: o.visibilityOk,
      extraTaps: 0,
    }),
    leave: (id) => m.handle({ type: 'DISCONNECT', clientId: id }),
    seq,
  };
  return api;
}

/** GO まで進める。戻り値は GO 時点のコマンド */
function toCue(t) {
  t.ready('a'); t.ready('b');
  return t.fireGo();
}
const resultOf = (cmds) => cmds.find((c) => c.msg?.type === 'RESULT')?.msg ?? null;
const has = (cmds, type) => cmds.some((c) => c.msg?.type === type);
const who = (res, id) => res.players.find((p) => p.id === id);

/**
 * 正直なタップ。GO から `R + rtt` 経過した時点で到着させるので residual ≒ 0 になる。
 * 相手が先にタップしていても時刻が累積しないよう、GO からの絶対位置で置くこと。
 */
function honestTap(t, id, R, rtt = 10) {
  t.setSinceGo(R + rtt);
  return t.tap(id, { R, rtt: { median: rtt } });
}

/** 申告値と実際の到着時刻を食い違わせる（偽造の再現） */
function forgedTap(t, id, { claim, arriveAt, rtt = 10 }) {
  t.setSinceGo(arriveAt + rtt);
  return t.tap(id, { R: claim, rtt: { median: rtt } });
}

// ---------------------------------------------------------------- 判定（SET2-4 §5）

test('正常: 反応が速い側の勝ち', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 180);
  const res = resultOf(honestTap(t, 'b', 220));
  assert.equal(who(res, 'a').result, 'win');
  assert.equal(who(res, 'b').result, 'lose');
  assert.equal(res.recorded, true);
});

test('同着: 差が D 以内なら引き分け', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 200);
  const res = resultOf(honestTap(t, 'b', 210));
  assert.equal(who(res, 'a').result, 'draw');
  assert.match(res.reason, /同着/);
});

test('片方フライング: 押した側の負け', () => {
  const t = setup();
  t.ready('a'); t.ready('b');
  t.tap('a', { flying: true });     // ARMED 中
  const res = resultOf(t.fireGo().concat(honestTap(t, 'b', 200)));
  assert.equal(who(res, 'a').result, 'lose');
  assert.equal(who(res, 'b').result, 'win');
});

test('双方フライング: 引き分け', () => {
  const t = setup();
  t.ready('a'); t.ready('b');
  t.tap('a', { flying: true });
  const cmds = t.tap('b', { flying: true });
  const res = resultOf(cmds);
  assert.ok(res, '双方揃った時点で ARMED 中でも確定する');
  assert.equal(who(res, 'a').result, 'draw');
  assert.equal(res.reason, '双方フライング');
});

test('片方無入力: 期限超過で入力した側の勝ち', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 200);
  t.setSinceGo(3000);
  const res = resultOf(t.fireDeadline());
  assert.equal(who(res, 'a').result, 'win');
  assert.equal(who(res, 'b').noInput, true);
});

test('双方無入力: 引き分け', () => {
  const t = setup(); toCue(t);
  t.setSinceGo(3000);
  const res = resultOf(t.fireDeadline());
  assert.equal(who(res, 'a').result, 'draw');
  assert.equal(res.reason, '双方無入力');
});

test('GO前の切断: 相手を待たずに無効試合として即確定する', () => {
  const t = setup();
  t.ready('a'); t.ready('b');
  const res = resultOf(t.leave('a'));
  assert.ok(res, '相手の入力を待たない');
  assert.equal(who(res, 'a').result, 'void');
  assert.equal(who(res, 'b').result, 'void');
  assert.equal(res.recorded, false);
});

test('GO後の切断: 残った側の不戦勝', () => {
  const t = setup(); toCue(t);
  t.setSinceGo(100);
  const res = resultOf(t.leave('a'));
  assert.equal(who(res, 'b').result, 'win');
  assert.equal(who(res, 'a').result, 'lose');
  assert.match(res.reason, /不戦勝/);
  assert.equal(res.recorded, true, '不戦勝は戦績に計上する');
});

test('R < R_min: 予測入力として押した側の負け', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 50);
  const res = resultOf(honestTap(t, 'b', 300));
  assert.equal(who(res, 'a').result, 'lose');
  assert.equal(who(res, 'a').tooFast, true);
  assert.match(res.reason, /速すぎる/);
});

test('整合性違反: サーバー推定値に差し替えられ、偽造側が負ける', () => {
  const t = setup(); toCue(t);
  forgedTap(t, 'a', { claim: 120, arriveAt: 400 }); // 実際は 400ms で押しているのに 120ms と申告
  const res = resultOf(honestTap(t, 'b', 300));
  const a = who(res, 'a');
  assert.equal(a.Rsource, 'server-estimate');
  assert.equal(a.claimedR, 120);
  assert.ok(a.R > 350, `差し替え後の R は実タップ時刻に近いはず: ${a.R}`);
  assert.equal(a.result, 'lose', '偽造しても勝てない');
  assert.equal(who(res, 'b').result, 'win', '正直な側はちゃんと勝つ（グリーフィング対策）');
  assert.equal(res.recorded, false, '差し替えたラウンドは戦績に記録しない');
});

test('RTT の自己申告を膨らませても整合性検査はすり抜けられない', () => {
  const t = setup(); toCue(t);
  t.setSinceGo(410);
  // R を 120ms と偽り、さらに RTT を 300ms と申告して residual を打ち消そうとする
  t.m.handle({
    type: 'TAP', clientId: 'a', eventId: 99, matchId: 'm1', roundId: 1,
    R: 120, rtt: { median: 300 }, serverRtt: { median: 10 },
  });
  const res = resultOf(honestTap(t, 'b', 300));
  assert.equal(who(res, 'a').Rsource, 'server-estimate', 'serverRtt が優先される');
  assert.equal(who(res, 'a').result, 'lose');
});

test('バックグラウンド化: 差し替えて記録しない', () => {
  const t = setup(); toCue(t);
  t.setSinceGo(210);
  t.tap('a', { R: 200, rtt: { median: 10 }, visibilityOk: false });
  const res = resultOf(honestTap(t, 'b', 300));
  assert.equal(who(res, 'a').untrusted, 'バックグラウンド化');
  assert.equal(res.recorded, false);
});

// ---------------------------------------------------------------- 重複・順序・第三者（SET2-2 §5・§7）

test('連打: 最初の1回だけ採用し、回数を数える', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 200);
  t.advance(50); t.tap('a', { R: 999 });
  t.advance(50); t.tap('a', { R: 999 });
  t.setSinceGo(310);
  const res = resultOf(honestTap(t, 'b', 300));
  assert.equal(who(res, 'a').R, 200, '2回目以降は無視される');
  assert.equal(who(res, 'a').extraTaps, 2);
  assert.equal(who(res, 'a').result, 'win');
});

test('重複 eventId: 再送は処理しない', () => {
  const t = setup(); toCue(t);
  t.setSinceGo(210);
  t.tap('a', { R: 200, eventId: 5 });
  const before = t.m.round.rec.get('a').tap.extraTaps ?? 0;
  t.tap('a', { R: 999, eventId: 5 }); // 同じ eventId の再送
  assert.equal(t.m.round.rec.get('a').tap.R, 200);
  assert.equal(t.m.round.rec.get('a').tap.extraTaps ?? 0, before, '再送は連打としても数えない');
});

test('古い roundId 宛の入力は捨てる', () => {
  const t = setup(); toCue(t);
  const cmds = t.tap('a', { R: 200, roundId: 0 });
  assert.deepEqual(cmds, [], 'エラーも返さない');
  assert.equal(t.m.round.rec.get('a').tap, null);
});

test('別 matchId 宛の入力は捨てる', () => {
  const t = setup(); toCue(t);
  const cmds = t.tap('a', { R: 200, matchId: 'other' });
  assert.deepEqual(cmds, []);
  assert.equal(t.m.round.rec.get('a').tap, null);
});

test('第三者の入力は捨てる', () => {
  const t = setup(); toCue(t);
  const cmds = t.m.handle({
    type: 'TAP', clientId: 'x', eventId: 1, matchId: 'm1', roundId: 1, R: 10, rtt: { median: 10 },
  });
  assert.deepEqual(cmds, [], '参加者でない clientId は無視する');
});

test('確定後に届いた入力は捨てる', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 180);
  honestTap(t, 'b', 220);
  const late = t.tap('a', { R: 1 });
  assert.deepEqual(late, []);
});

// ---------------------------------------------------------------- 一度だけの確定（§6）

test('入力完了と期限超過が同時に起きても結果は1回だけ', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 180);
  const first = honestTap(t, 'b', 220);
  assert.ok(resultOf(first), '入力が揃って確定する');
  const second = t.fireDeadline(); // 直後にタイマーが発火した想定
  assert.equal(resultOf(second), null, '2回目の RESULT は出ない');
});

test('確定時に GO・期限の両タイマーを解除する', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 180);
  const cmds = honestTap(t, 'b', 220);
  const cleared = cmds.filter((c) => c.type === 'clearTimer').map((c) => c.name);
  assert.ok(cleared.includes(TIMER.GO));
  assert.ok(cleared.includes(TIMER.DEADLINE));
});

test('resultId は matchId:roundId', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 180);
  const res = resultOf(honestTap(t, 'b', 220));
  assert.equal(res.resultId, 'm1:1');
});

// ---------------------------------------------------------------- 情報を漏らさない（§4.2・§3.1）

test('ARMED に待機時間 W を含めない', () => {
  const t = setup();
  t.ready('a');
  const cmds = t.ready('b');
  const armed = cmds.find((c) => c.msg?.type === 'ARMED').msg;
  assert.deepEqual(Object.keys(armed).sort(), ['matchId', 'roundId', 'type']);
});

test('片方がフライングしても相手には知らせず、状態も変えない', () => {
  const t = setup();
  t.ready('a'); t.ready('b');
  const cmds = t.tap('a', { flying: true });
  assert.deepEqual(cmds, [], 'フライングの事実を送信しない');
  assert.equal(t.m.state, STATE.ARMED, '状態は ARMED のまま相手の入力を待つ');
});

// ---------------------------------------------------------------- ルームの後始末（§8）

test('双方切断でルームを閉じ、全タイマーを解除する', () => {
  const t = setup();
  t.leave('a');
  const cmds = t.leave('b');
  assert.ok(cmds.some((c) => c.type === 'closed'));
  const cleared = cmds.filter((c) => c.type === 'clearTimer').map((c) => c.name);
  for (const name of [TIMER.GO, TIMER.DEADLINE, TIMER.IDLE]) assert.ok(cleared.includes(name));
  assert.equal(t.m.state, STATE.CLOSED);
});

test('確定後は再戦待ちのアイドルタイマーを張る', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 180);
  const cmds = honestTap(t, 'b', 220);
  const idle = cmds.find((c) => c.type === 'setTimer' && c.name === TIMER.IDLE);
  assert.ok(idle, 'アイドルタイマーが張られる');
  assert.equal(idle.delayMs, 60000);
});

test('アイドルタイムアウトでルームを閉じる', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 180); honestTap(t, 'b', 220);
  const cmds = t.m.handle({ type: 'TIMER', name: TIMER.IDLE });
  assert.ok(cmds.some((c) => c.type === 'closed'));
  assert.equal(t.m.state, STATE.CLOSED);
});

test('閉じたルームは以後どのイベントも受け付けない', () => {
  const t = setup();
  t.leave('a'); t.leave('b');
  assert.deepEqual(t.ready('a'), []);
  assert.deepEqual(t.m.handle({ type: 'TIMER', name: TIMER.GO }), []);
});

// ---------------------------------------------------------------- 再戦

test('確定後にもう一度 READY すると次のラウンドが始まる', () => {
  const t = setup(); toCue(t);
  honestTap(t, 'a', 180); honestTap(t, 'b', 220);
  assert.equal(t.m.state, STATE.WAITING);
  t.ready('a');
  const cmds = t.ready('b');
  assert.ok(has(cmds, 'ARMED'));
  assert.equal(t.m.round.roundId, 2, 'roundId が進む');
});

test('solo は勝敗をつけず計測値だけ残す', () => {
  const t = setup([{ id: 'a', name: 'A' }]);
  t.ready('a'); t.fireGo();
  const res = resultOf(honestTap(t, 'a', 200));
  assert.equal(who(res, 'a').result, 'solo');
  assert.equal(res.reason, '計測のみ');
});
