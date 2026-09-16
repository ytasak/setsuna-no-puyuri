// 判定の単体テスト。
//
// 見るところは3つしかない ——「合図の前に抜いたか」「抜いたか」「どちらが速いか」。
// 同着幅も生理的下限も切断も持たないので、場合分けはこれで尽きている。

import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_CFG } from './match.js';

const tap = (R) => ({ flying: false, noInput: false, R });
const flying = { flying: true, noInput: false, R: null };
const noInput = { flying: false, noInput: true, R: null };

test('速いほうが勝つ', () => {
  assert.equal(decide(tap(180), tap(240)), 'win');
  assert.equal(decide(tap(240), tap(180)), 'lose');
});

test('わずかな差でも勝ち負けが付く。同着の幅は無い', () => {
  assert.equal(decide(tap(200), tap(200.5)), 'win');
  assert.equal(decide(tap(200.5), tap(200)), 'lose');
});

test('まったく同じ値なら自分の勝ち', () => {
  // 実際には起こらないが、決まらない場合を残さない
  assert.equal(decide(tap(200), tap(200)), 'win');
});

test('人間離れした速さでも弾かれない。生理的下限は無い', () => {
  assert.equal(decide(tap(3), tap(180)), 'win');
});

test('合図の前に抜けば、相手より速くても負ける', () => {
  assert.equal(decide(flying, tap(400)), 'lose');
  assert.equal(decide(tap(400), flying), 'win');
});

test('双方フライングなら自分の負け', () => {
  // 相手はフライングしないので実際には起こらない。判定を先に評価する側で決める
  assert.equal(decide(flying, flying), 'lose');
});

test('抜かなければ負ける。フライングのほうが先に効く', () => {
  assert.equal(decide(noInput, tap(400)), 'lose');
  assert.equal(decide(tap(400), noInput), 'win');
  assert.equal(decide({ flying: true, noInput: true, R: null }, tap(400)), 'lose');
});

test('待機の範囲と入力期限だけを持つ', () => {
  assert.deepEqual(Object.keys(DEFAULT_CFG).sort(), ['inputDeadline', 'wMax', 'wMin']);
  assert.ok(DEFAULT_CFG.wMin < DEFAULT_CFG.wMax);
  assert.ok(DEFAULT_CFG.inputDeadline > 0);
});
