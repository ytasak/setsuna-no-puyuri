// 対戦1ルームの状態遷移と判定。
//
// **I/O を持たない。** 時計もランダムも外から注入する。
// これは docs/set2-2-realtime-match.md §9.5 の方針によるもので、
// Node + ws と Cloudflare Durable Objects のどちらにも載せられるようにするため。
// 副作用は「コマンド」として返すだけで、実行はアダプタの責任。
//
// 判定規則の本体は docs/set2-4-sync-fairness.md §5。

export const STATE = {
  WAITING: 'WAITING',
  ARMED: 'ARMED',
  CUE: 'CUE',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
};

export const DEFAULT_CFG = {
  wMin: 1000,           // ランダム待機の下限 [ms]
  wMax: 4000,           // ランダム待機の上限 [ms]
  inputDeadline: 3000,  // 入力期限 T [ms]
  tieBand: 20,          // 同着幅 D [ms]
  rMin: 100,            // 生理的下限 R_min [ms]
  eps: 80,              // 整合性検査の許容幅 ε [ms]
  rematchTimeout: 60000,
  idleTimeout: 120000,
};

export const TIMER = { GO: 'go', DEADLINE: 'deadline', IDLE: 'idle' };

const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * @param {object} opts
 * @param {string} opts.matchId
 * @param {Array<{id:string,name?:string,label?:string}>} opts.players 2人（solo 計測時は1人）
 * @param {() => number} opts.now 単調増加する時計。ミリ秒
 * @param {() => number} [opts.random] 0〜1。待機時間の決定に使う
 * @param {object} [opts.cfg]
 */
export function createMatch({ matchId, players, now, random = Math.random, cfg = {} }) {
  return new Match({ matchId, players, now, random, cfg: { ...DEFAULT_CFG, ...cfg } });
}

class Match {
  constructor({ matchId, players, now, random, cfg }) {
    this.matchId = matchId;
    this.cfg = cfg;
    this.now = now;
    this.random = random;
    this.state = STATE.WAITING;
    this.roundSeq = 0;
    this.round = null;
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      label: p.label ?? '',
      ready: false,
      connected: true,
      lastEventId: 0,
    }));
  }

  get capacity() { return this.players.length; }
  player(id) { return this.players.find((p) => p.id === id); }
  snapshot() {
    return {
      matchId: this.matchId,
      state: this.state,
      roundId: this.round?.roundId ?? null,
      members: this.players.map((p) => ({ id: p.id, name: p.name, ready: p.ready, connected: p.connected })),
    };
  }

  /**
   * イベントを1つ処理し、アダプタが実行すべきコマンドの配列を返す。
   * コマンド: {type:'send'|'broadcast'|'setTimer'|'clearTimer'|'closed', ...}
   *
   * 受理しなかったイベントは空配列を返す。**エラーは返さない**
   * （docs/set2-2-realtime-match.md §5.1: 状態や参加者を外から探れてしまうため）。
   */
  handle(ev) {
    if (this.state === STATE.CLOSED) return [];
    switch (ev.type) {
      case 'READY': return this.#onReady(ev);
      case 'TAP': return this.#onTap(ev);
      case 'LEAVE': return this.#onLeave(ev, false);
      case 'DISCONNECT': return this.#onLeave(ev, true);
      case 'TIMER': return this.#onTimer(ev);
      default: return [];
    }
  }

  // ------------------------------------------------------------ ガード

  /** 送信元が参加者で、再送でないか。第三者の入力はここで落ちる（§7） */
  #accept(ev) {
    const p = this.player(ev.clientId);
    if (!p || !p.connected) return null;
    if (typeof ev.eventId === 'number') {
      if (ev.eventId <= p.lastEventId) return null; // 再送・重複
      p.lastEventId = ev.eventId;
    }
    return p;
  }

  /** そのラウンド宛の入力か。古い roundId・別マッチ宛はここで落ちる（§5.1） */
  #forCurrentRound(ev) {
    if (!this.round || this.round.resolved) return false;
    if (ev.matchId !== undefined && ev.matchId !== this.matchId) return false;
    if (ev.roundId !== undefined && ev.roundId !== this.round.roundId) return false;
    return true;
  }

  // ------------------------------------------------------------ 遷移

  #onReady(ev) {
    const p = this.#accept(ev);
    if (!p) return [];
    if (this.state !== STATE.WAITING && this.state !== STATE.RESOLVED) return [];
    p.ready = true;

    const cmds = [{ type: 'broadcast', msg: { type: 'STATE', ...this.snapshot() } }];
    const active = this.players.filter((x) => x.connected);
    if (active.length < this.capacity || !active.every((x) => x.ready)) return cmds;

    // 全員の準備が揃った。ARMED へ
    this.state = STATE.ARMED;
    this.roundSeq += 1;
    const w = this.cfg.wMin + this.random() * (this.cfg.wMax - this.cfg.wMin);
    this.round = {
      roundId: this.roundSeq,
      w,
      goSentAt: null,
      resolved: false,
      participants: active.map((x) => x.id),
      rec: new Map(active.map((x) => [x.id, {
        playerId: x.id, tap: null, tapRecvAt: null, disconnectedAt: null, sawGo: false,
      }])),
    };
    cmds.push({ type: 'clearTimer', name: TIMER.IDLE });
    // W は ARMED に載せない。載せると待ち時間が読めてフライングし放題になる（§4.2）
    cmds.push({ type: 'broadcast', msg: { type: 'ARMED', matchId: this.matchId, roundId: this.round.roundId } });
    cmds.push({ type: 'setTimer', name: TIMER.GO, delayMs: w });
    return cmds;
  }

  #onTap(ev) {
    const p = this.#accept(ev);
    if (!p) return [];
    // ARMED 中の入力＝フライング。CUE 中は通常の入力。それ以外の状態では捨てる
    if (this.state !== STATE.ARMED && this.state !== STATE.CUE) return [];
    if (!this.round || this.round.resolved) return [];
    if (ev.matchId !== undefined && ev.matchId !== this.matchId) return [];
    // ARMED 中はまだ roundId を知らせているので照合する。不一致は古い入力
    if (ev.roundId !== undefined && ev.roundId !== this.round.roundId) return [];

    const rec = this.round.rec.get(p.id);
    if (!rec) return []; // 参加者でない（途中参加など）
    if (rec.tap) { // 連打（ケース12）。最初の1回だけ採用し、回数だけ数える
      rec.tap.extraTaps = (rec.tap.extraTaps ?? 0) + 1;
      return [];
    }

    rec.tapRecvAt = this.now();
    rec.tap = {
      flying: !!ev.flying,
      R: typeof ev.R === 'number' ? ev.R : null,
      recvToPaint: ev.recvToPaint ?? null,
      inputToHandler: ev.inputToHandler ?? null,
      frameInterval: ev.frameInterval ?? null,
      visibilityOk: ev.visibilityOk !== false,
      forged: !!ev.forged,
      synthetic: !!ev.synthetic,
      extraTaps: ev.extraTaps ?? 0,
      rtt: ev.rtt ?? {},           // クライアントの自己申告。診断用にしか使わない
      serverRtt: ev.serverRtt ?? null, // サーバーが自分で測った値。整合性検査はこちらを使う
    };

    // ARMED 中のフライングでは state を変えない。
    // ここで即決着させると、先にフライングした側が相手の入力機会を奪う（§3.1）
    return this.#resolveIfComplete();
  }

  #onLeave(ev, isDisconnect) {
    const p = this.player(ev.clientId);
    if (!p || !p.connected) return [];
    p.connected = false;
    p.ready = false;

    // ラウンド中の切断は相手の入力を待たずに即確定させる（§3.1）。
    // 待つと、切断した側の相手が出ない合図をいつまでも待つことになる。
    if (this.round && !this.round.resolved && this.round.rec.has(p.id)) {
      this.round.rec.get(p.id).disconnectedAt = this.now();
      return this.#resolve('切断');
    }
    const cmds = [
      { type: 'broadcast', msg: { type: 'PEER_LEFT', matchId: this.matchId, who: p.name, disconnect: isDisconnect } },
    ];
    return cmds.concat(this.#closeIfEmpty());
  }

  #onTimer(ev) {
    if (ev.name === TIMER.GO) return this.#fireGo();
    if (ev.name === TIMER.DEADLINE) return this.#resolve('期限超過');
    if (ev.name === TIMER.IDLE) return this.#close();
    return [];
  }

  #fireGo() {
    if (this.state !== STATE.ARMED || !this.round || this.round.resolved) return [];
    this.state = STATE.CUE;
    this.round.goSentAt = this.now();
    for (const id of this.round.participants) this.round.rec.get(id).sawGo = true;

    const cmds = [
      { type: 'broadcast', msg: { type: 'GO', matchId: this.matchId, roundId: this.round.roundId } },
      { type: 'setTimer', name: TIMER.DEADLINE, delayMs: this.cfg.inputDeadline },
    ];
    // W 経過前に全員フライング済みなら、GO 送信と同時に判定できる
    return cmds.concat(this.#resolveIfComplete());
  }

  #resolveIfComplete() {
    const r = this.round;
    if (!r || r.resolved) return [];
    const done = r.participants.every((id) => {
      const rec = r.rec.get(id);
      return rec.tap || rec.disconnectedAt;
    });
    if (!done) return [];
    // ARMED 中に全員分が揃った（全員フライング or 切断）場合もここで確定させる
    return this.#resolve(this.state === STATE.ARMED ? '合図前に決着' : '入力が揃った');
  }

  // ------------------------------------------------------------ 判定

  /** 結果は一度だけ確定する。判定の契機は「入力が揃う」「期限超過」「切断」の3つで、同時に発火し得る（§6.1） */
  #resolve() {
    const r = this.round;
    if (!r || r.resolved) return [];
    r.resolved = true;
    this.state = STATE.RESOLVED;

    const ps = r.participants.map((id) => this.#summarize(r.rec.get(id), r));
    let verdict, reason;

    if (ps.length === 2) {
      const d = decide(ps[0], ps[1], this.cfg);
      reason = d.reason;
      verdict = { [ps[0].id]: d[ps[0].id], [ps[1].id]: d[ps[1].id] };
    } else {
      const p = ps[0];
      applyTrust(p, this.cfg);
      reason = p.flying ? 'フライング' : p.tooFast ? '反応が速すぎる'
        : p.noInput ? '無入力' : p.untrusted ? `計測のみ（${p.untrusted}）` : '計測のみ';
      verdict = { [p.id]: (p.flying || p.tooFast || p.noInput) ? 'void' : 'solo' };
    }

    const recorded = !ps.some((p) => p.untrusted) && !Object.values(verdict).some((v) => v === 'void');
    const result = {
      type: 'RESULT',
      matchId: this.matchId,
      roundId: r.roundId,
      resultId: `${this.matchId}:${r.roundId}`, // SET2-6 の一意キー（§6.2）
      reason,
      recorded,
      w: r2(r.w),
      players: ps.map((p) => ({
        id: p.id, name: p.name, result: verdict[p.id],
        R: r2(p.Rused ?? p.R), claimedR: r2(p.R), Rsource: p.Rsource ?? 'claimed',
        flying: p.flying, tooFast: p.tooFast, noInput: p.noInput, disconnected: p.disconnected,
        untrusted: p.untrusted ?? null,
        serverElapsed: r2(p.serverElapsed), residual: r2(p.residual),
        recvToPaint: r2(p.tap?.recvToPaint), inputToHandler: r2(p.tap?.inputToHandler),
        frameInterval: r2(p.tap?.frameInterval), extraTaps: p.tap?.extraTaps ?? 0,
      })),
    };
    this.lastResult = result;
    this.lastSummaries = ps;

    for (const p of this.players) p.ready = false;
    this.state = STATE.WAITING;
    this.round = null;

    const cmds = [
      { type: 'clearTimer', name: TIMER.GO },
      { type: 'clearTimer', name: TIMER.DEADLINE },
      { type: 'broadcast', msg: result },
      { type: 'broadcast', msg: { type: 'STATE', ...this.snapshot() } },
      { type: 'setTimer', name: TIMER.IDLE, delayMs: this.cfg.rematchTimeout },
    ];
    return cmds.concat(this.#closeIfEmpty());
  }

  #summarize(rec, round) {
    const p = this.player(rec.playerId);
    const tap = rec.tap;
    // 整合性検査に自己申告の RTT を使ってはいけない。
    // R も rtt もクライアントが握っていると、R を小さく・rtt を大きく申告するだけで
    // residual = serverElapsed - R - rtt を 0 に寄せられ、検査をすり抜けられる。
    // サーバーが自分で測った serverRtt を優先し、無い場合だけ申告値に落ちる。
    const rtt = tap?.serverRtt ?? tap?.rtt ?? {};
    const serverElapsed = rec.tapRecvAt !== null && round.goSentAt !== null
      ? rec.tapRecvAt - round.goSentAt : null;
    // 正直な計測なら serverElapsed ≒ RTT + R となり residual ≒ 0（SET2-4 §3 方式C-2）
    const residual = serverElapsed !== null && tap?.R != null && typeof rtt.median === 'number'
      ? serverElapsed - tap.R - rtt.median : null;

    return {
      id: p.id, name: p.name, label: p.label, tap, rtt, serverElapsed, residual,
      flying: !!tap?.flying,
      // ケース9: 生理的下限未満。予測入力とみなしフライングと同層で扱う
      tooFast: !tap?.flying && typeof tap?.R === 'number' && tap.R < this.cfg.rMin,
      R: tap?.R ?? null,
      noInput: !tap && !rec.disconnectedAt,
      disconnected: !!rec.disconnectedAt,
      disconnectedBeforeGo: !!rec.disconnectedAt && !rec.sawGo,
      disconnectedAfterGo: !!rec.disconnectedAt && rec.sawGo,
    };
  }

  #closeIfEmpty() {
    if (this.players.some((p) => p.connected)) return [];
    return this.#close();
  }

  #close() {
    if (this.state === STATE.CLOSED) return [];
    this.state = STATE.CLOSED;
    this.round = null;
    // タイマーは必ず解除する。残すと削除済みルームを参照するコールバックが生きてしまう（§8.1）
    return [
      { type: 'clearTimer', name: TIMER.GO },
      { type: 'clearTimer', name: TIMER.DEADLINE },
      { type: 'clearTimer', name: TIMER.IDLE },
      { type: 'closed', matchId: this.matchId },
    ];
  }
}

// ---------------------------------------------------------------- 判定関数（純粋）

/**
 * §5 ケース10・11。申告値を信用しない理由であって、不正の断定ではない。
 * ケース9（R < R_min）は含めない。申告値が実際のタップ時刻と一致していても成立するため、
 * サーバー推定値への差し替えでは救えない。フライングと同層（tooFast）で扱う。
 */
export function untrustedReason(p, cfg) {
  if (p.flying || p.tooFast || p.noInput || p.disconnected) return null;
  if (p.R === null) return null;
  if (p.residual !== null && Math.abs(p.residual) > cfg.eps) {
    return `整合性違反(residual=${r2(p.residual)}ms)`;
  }
  if (p.tap && p.tap.visibilityOk === false) return 'バックグラウンド化';
  return null;
}

/**
 * 申告値が信用できない場合、サーバー推定値に差し替える（SET2-4 §5.3）。
 * 試合を無効にしない。無効にすると、勝てない相手が意図的に違反を起こして
 * 相手の勝ちを消し続けられる（グリーフィング）。
 */
export function applyTrust(p, cfg) {
  p.untrusted = untrustedReason(p, cfg);
  if (!p.untrusted) { p.Rused = p.R; p.Rsource = 'claimed'; return p; }
  const est = p.serverElapsed !== null && typeof p.rtt?.median === 'number'
    ? p.serverElapsed - p.rtt.median : null;
  p.Rused = est ?? p.R; // 推定できなければ申告値のまま使う（判定不能にはしない）
  p.Rsource = est !== null ? 'server-estimate' : 'claimed';
  return p;
}

/**
 * docs/set2-4-sync-fairness.md §5 の判定。
 * 優先順位: 切断(GO前) > フライング・速すぎる入力 > 切断(GO後) > 無入力 > 信用検査 > 同着 > 反応時間比較
 */
export function decide(a, b, cfg) {
  const out = (ra, rb, reason) => ({ [a.id]: ra, [b.id]: rb, reason });
  const draw = (reason) => out('draw', 'draw', reason);
  const voidMatch = (reason) => out('void', 'void', reason);
  const win = (w, _l, reason) => (w.id === a.id ? out('win', 'lose', reason) : out('lose', 'win', reason));

  const early = (p) => p.flying || p.tooFast;
  const earlyLabel = (p) => (p.tooFast ? `反応が速すぎる(R=${r2(p.R)}ms)` : 'フライング');

  if (a.disconnectedBeforeGo || b.disconnectedBeforeGo) return voidMatch('切断(GO前)');       // ケース7
  if (early(a) && early(b)) return draw('双方フライング');                                     // ケース4
  if (early(a)) return win(b, a, earlyLabel(a));                                              // ケース3・9
  if (early(b)) return win(a, b, earlyLabel(b));
  if (a.disconnectedAfterGo && b.disconnectedAfterGo) return voidMatch('双方切断(GO後)');
  if (a.disconnectedAfterGo) return win(b, a, '切断による不戦勝');                             // ケース8
  if (b.disconnectedAfterGo) return win(a, b, '切断による不戦勝');
  if (a.noInput && b.noInput) return draw('双方無入力');                                       // ケース6
  if (a.noInput) return win(b, a, '相手が無入力');                                             // ケース5
  if (b.noInput) return win(a, b, '相手が無入力');

  // ケース10・11 は勝敗を止めず、R を差し替えて判定する（SET2-4 §5.3）
  applyTrust(a, cfg); applyTrust(b, cfg);
  const note = [a, b].filter((p) => p.untrusted)
    .map((p) => `${p.name}: ${p.untrusted}→サーバー推定値で判定`).join(' / ');
  const suffix = note ? `（${note}・戦績に記録しない）` : '';

  if (Math.abs(a.Rused - b.Rused) <= cfg.tieBand) {
    return draw(`同着(差${r2(Math.abs(a.Rused - b.Rused))}ms)${suffix}`);                       // ケース2
  }
  return a.Rused < b.Rused ? win(a, b, `反応が速い${suffix}`) : win(b, a, `反応が速い${suffix}`); // ケース1
}
