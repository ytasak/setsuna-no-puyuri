// SET2-4 実測用クライアント（使い捨て）
//
// 計測の考え方は docs/set2-4-sync-fairness.md §2 に対応する。
//   t_recv   : GO を受信した時刻            performance.now()
//   t_paint  : 合図の描画処理が走った時刻    requestAnimationFrame コールバック引数
//   t_display: 実際に画面に出た時刻（推定）  t_paint + フレーム間隔
//   t_input  : 入力のハードウェア時刻        PointerEvent.timeStamp
//   R = t_input - t_display
// t_display は取得できないため R は常に推定値である、という前提を崩さないこと。

'use strict';

// ---------------------------------------------------------------- 起動パラメータ

const qs = new URLSearchParams(location.search);
const params = {
  room: qs.get('room') || 'lab',
  mode: qs.get('mode') === 'solo' ? 'solo' : 'duel',
  name: qs.get('name') || 'p' + Math.random().toString(36).slice(2, 6),
  label: qs.get('label') || '',
  delayUp: Number(qs.get('delayUp') || 0),
  delayDown: Number(qs.get('delayDown') || 0),
};

const $ = (id) => document.getElementById(id);
const el = {
  conn: $('conn'), connText: $('connText'), roomId: $('roomId'), mode: $('mode'),
  me: $('me'), peer: $('peer'), delays: $('delays'),
  stage: $('stage'), face: $('face'), phase: $('phase'), verdict: $('verdict'), sub: $('sub'),
  ready: $('ready'), auto: $('auto'), autoMs: $('autoMs'), forge: $('forge'),
  calib: $('calib'), dl: $('dl'),
  mRes: $('mRes'), mFrame: $('mFrame'), mFrameP95: $('mFrameP95'), mHz: $('mHz'),
  mRtt: $('mRtt'), mRttP95: $('mRttP95'), mJit: $('mJit'), mRttN: $('mRttN'),
  mRecvPaint: $('mRecvPaint'), mInHandler: $('mInHandler'),
  mElapsed: $('mElapsed'), mResidual: $('mResidual'),
  log: document.querySelector('#log tbody'),
};

el.roomId.textContent = params.room;
el.mode.textContent = params.mode;
el.me.textContent = params.name;
el.delays.textContent = `up ${params.delayUp} / down ${params.delayDown} ms`;

// ---------------------------------------------------------------- 統計ヘルパ

const ms = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) + ' ms' : '—');
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function percentile(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
function jitter(a) { if (a.length < 2) return null; let sum = 0; for (let i = 1; i < a.length; i++) sum += Math.abs(a[i] - a[i - 1]); return sum / (a.length - 1); }

// ---------------------------------------------------------------- フレーム計測（常時）

const frameTs = [];
let frameIntervals = [];
requestAnimationFrame(function loop(ts) {
  frameTs.push(ts);
  if (frameTs.length > 121) frameTs.shift();
  if (frameTs.length > 1) {
    frameIntervals = [];
    for (let i = 1; i < frameTs.length; i++) frameIntervals.push(frameTs[i] - frameTs[i - 1]);
  }
  requestAnimationFrame(loop);
});
const frameInterval = () => median(frameIntervals) ?? 16.7;

// ---------------------------------------------------------------- 時計の分解能

function clockResolution() {
  let prev = performance.now(), min = Infinity;
  const stopAt = prev + 60; // 60ms 以内で打ち切る
  for (let i = 0; i < 3e6; i++) {
    const t = performance.now();
    const d = t - prev;
    if (d > 0) { if (d < min) min = d; prev = t; if (t > stopAt) break; }
  }
  return isFinite(min) ? min : null;
}

// ---------------------------------------------------------------- 状態

const st = {
  phase: 'idle',
  roundId: null,
  tRecv: null, tPaint: null, tDisplay: null, frameInterval: null,
  extraTaps: 0,
  visibilityOk: true,
};
const rtts = [];
const localRows = [];
let ws = null, pingSeq = 0;
const pendingPings = new Map();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && ['armed', 'cuePending', 'cue'].includes(st.phase)) {
    st.visibilityOk = false;
  }
});

function rttStats() {
  const a = rtts.slice(-60);
  return { median: median(a), p95: percentile(a, 0.95), jitter: jitter(a), n: a.length };
}

// ---------------------------------------------------------------- 画面

function setPhase(phase, text, sub) {
  st.phase = phase;
  el.phase.textContent = text;
  if (sub !== undefined) el.sub.textContent = sub;
  el.stage.className = phase === 'armed' ? 'armed' : phase === 'cue' ? 'cue' : phase === 'result' ? 'result' : 'idle';
  if (phase !== 'result') el.verdict.textContent = '';
}

function renderMetrics() {
  el.mFrame.textContent = ms(median(frameIntervals));
  el.mFrameP95.textContent = ms(percentile(frameIntervals, 0.95));
  const fi = median(frameIntervals);
  el.mHz.textContent = fi ? Math.round(1000 / fi) + ' Hz' : '—';
  const r = rttStats();
  el.mRtt.textContent = ms(r.median);
  el.mRttP95.textContent = ms(r.p95);
  el.mJit.textContent = ms(r.jitter);
  el.mRttN.textContent = r.n;
}
setInterval(renderMetrics, 500);

// ---------------------------------------------------------------- 通信

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({
    room: params.room, mode: params.mode, name: params.name, label: params.label,
    delayUp: params.delayUp, delayDown: params.delayDown,
  });
  ws = new WebSocket(`${proto}://${location.host}/?${q}`);

  ws.onopen = () => {
    el.conn.classList.add('on');
    el.connText.textContent = '接続済み';
    el.ready.disabled = false;
    setPhase('idle', '準備を押してください', '合図（緑）が出たらタップ。先に押すと負け。');
  };
  ws.onclose = () => {
    el.conn.classList.remove('on');
    el.connText.textContent = '切断（再接続中…）';
    el.ready.disabled = true;
    setPhase('idle', '切断されました');
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    onMessage(m);
  };
}

function onMessage(m) {
  switch (m.type) {
    case 'WELCOME':
      el.me.textContent = `${params.name} (${m.clientId})`;
      break;
    case 'FULL':
      setPhase('idle', 'ルームが満員です', `定員 ${m.capacity} 人。別の room 名を使うこと。`);
      break;
    case 'STATE': {
      const others = m.room.members.filter((x) => !el.me.textContent.includes(x.id));
      el.peer.textContent = others.length ? others.map((o) => o.name + (o.ready ? '(準備済)' : '')).join(', ') : '—';
      if (st.phase === 'idle' || st.phase === 'waiting' || st.phase === 'result') {
        el.ready.disabled = false;
        el.ready.textContent = '準備する';
      }
      break;
    }
    case 'ARMED':
      st.roundId = m.roundId;
      st.tRecv = st.tPaint = st.tDisplay = null;
      st.extraTaps = 0;
      st.visibilityOk = document.visibilityState === 'visible';
      el.ready.disabled = true;
      setPhase('armed', 'まだ！', '緑になるまで待つ。今押すとフライング負け。');
      break;
    case 'GO':
      onGo(m);
      break;
    case 'RESULT':
      onResult(m);
      break;
    case 'PONG': {
      const sent = pendingPings.get(m.seq);
      if (sent !== undefined) {
        rtts.push(performance.now() - sent);
        if (rtts.length > 200) rtts.shift();
        pendingPings.delete(m.seq);
      }
      break;
    }
    case 'CALIB_OK':
      el.calib.textContent = 'キャリブレーション記録済み';
      setTimeout(() => { el.calib.textContent = 'キャリブレーション実行'; }, 1500);
      break;
  }
}

setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  const seq = ++pingSeq;
  pendingPings.set(seq, performance.now());
  send({ type: 'PING', seq });
  if (pendingPings.size > 30) pendingPings.delete([...pendingPings.keys()][0]);
}, 400);

// ---------------------------------------------------------------- GO と入力

function onGo(m) {
  st.roundId = m.roundId;
  st.tRecv = performance.now();
  st.phase = 'cuePending'; // この時点の入力もフライング（まだ表示されていない）
  requestAnimationFrame((ts) => {
    st.tPaint = ts;
    st.frameInterval = frameInterval();
    // 実際の表示は描画処理の 1 フレーム後と推定する（§2.1）
    st.tDisplay = ts + st.frameInterval;
    setPhase('cue', 'いま！', '');
    el.face.textContent = '🥺';
    if (el.auto.checked) scheduleAutoTap();
  });
}

function scheduleAutoTap() {
  const target = Number(el.autoMs.value) || 0;
  const wait = st.tDisplay + target - performance.now();
  setTimeout(() => {
    if (st.phase !== 'cue') return;
    const t = performance.now();
    handleInput(t, t, true);
  }, Math.max(0, wait));
}

/** e.timeStamp は performance.now() と同じ time origin のはずだが、値が壊れている場合に備える */
function inputTime(e, fallback) {
  const ts = e.timeStamp;
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return fallback;
  if (Math.abs(ts - fallback) > 60000) return fallback; // 別の epoch を返す実装への保険
  return ts;
}

function handleInput(tInput, tHandler, synthetic) {
  if (st.phase === 'armed' || st.phase === 'cuePending') {
    // §5 ケース3: 合図の表示前に入力した = フライング
    send({ type: 'TAP', roundId: st.roundId, flying: true, synthetic, rtt: rttStats() });
    setPhase('sent', '送信済み', 'フライングを申告しました。');
    return;
  }
  if (st.phase !== 'cue') { st.extraTaps++; return; } // §5 ケース12 連打

  let R = tInput - st.tDisplay;
  if (R < 0) {
    // 描画処理は走ったが、推定表示時刻より前に入力された
    send({ type: 'TAP', roundId: st.roundId, flying: true, synthetic, rtt: rttStats() });
    setPhase('sent', '送信済み', 'フライングを申告しました。');
    return;
  }
  const forged = el.forge.checked;
  if (forged) R = 120; // §7.4 整合性検査が偽造を捕まえるかの確認用

  send({
    type: 'TAP', roundId: st.roundId, flying: false, R,
    recvToPaint: st.tPaint - st.tRecv,
    inputToHandler: tHandler - tInput,
    frameInterval: st.frameInterval,
    visibilityOk: st.visibilityOk,
    forged, synthetic, extraTaps: st.extraTaps,
    rtt: rttStats(),
  });
  setPhase('sent', '送信済み', `申告 R = ${R.toFixed(1)} ms`);
}

el.stage.addEventListener('pointerdown', (e) => {
  const tHandler = performance.now();
  handleInput(inputTime(e, tHandler), tHandler, false);
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  if (e.repeat) return;
  e.preventDefault();
  const tHandler = performance.now();
  handleInput(inputTime(e, tHandler), tHandler, false);
});

// ---------------------------------------------------------------- 結果

const RESULT_LABEL = { win: '勝ち', lose: '負け', draw: '引き分け', void: '無効試合', solo: '計測のみ' };

function onResult(m) {
  const meId = (el.me.textContent.match(/\((c\d+)\)/) || [])[1];
  const mine = m.players.find((p) => p.id === meId) || m.players[0];
  const other = m.players.find((p) => p.id !== mine.id);

  // 申告値を信用できなかった場合は理由を伏せずに出すが、不正とは書かない（§5.1）
  const notes = [];
  if (mine.Rsource === 'server-estimate') notes.push('この端末の計測値は使われませんでした');
  if (m.recorded === false) notes.push('この試合は記録されません');
  setPhase('result', RESULT_LABEL[mine.result] ?? mine.result,
    notes.length ? `${m.reason}\n${notes.join(' / ')}` : m.reason);
  el.verdict.textContent = RESULT_LABEL[mine.result] ?? mine.result;
  el.verdict.className = mine.result;
  el.ready.disabled = false;
  el.ready.textContent = 'もう一度';

  el.mRecvPaint.textContent = ms(mine.recvToPaint);
  el.mInHandler.textContent = ms(mine.inputToHandler);
  el.mElapsed.textContent = ms(mine.serverElapsed);
  el.mResidual.textContent = ms(mine.residual);

  const diff = mine.R != null && other?.R != null ? Math.abs(mine.R - other.R) : null;
  const row = {
    roundId: m.roundId, result: mine.result, R: mine.R, claimedR: mine.claimedR,
    Rsource: mine.Rsource, recorded: m.recorded, opponentR: other?.R ?? null, diff,
    recvToPaint: mine.recvToPaint, inputToHandler: mine.inputToHandler,
    frameInterval: mine.frameInterval, serverElapsed: mine.serverElapsed, residual: mine.residual,
    reason: m.reason, w: m.w, ts: new Date().toISOString(),
  };
  localRows.push(row);

  const tr = document.createElement('tr');
  const cells = [
    m.roundId,
    `<span class="${mine.result}">${RESULT_LABEL[mine.result] ?? mine.result}</span>`,
    fmt(mine.R), fmt(other?.R), fmt(diff),
    fmt(mine.recvToPaint), fmt(mine.frameInterval), fmt(mine.serverElapsed), fmt(mine.residual),
    m.reason,
  ];
  tr.innerHTML = cells.map((c) => `<td>${c}</td>`).join('');
  el.log.prepend(tr);
  while (el.log.children.length > 60) el.log.lastChild.remove();
}
const fmt = (v) => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) : '—');

// ---------------------------------------------------------------- 操作

el.ready.addEventListener('click', () => {
  el.ready.disabled = true;
  setPhase('waiting', '相手を待っています', params.mode === 'solo' ? '' : '双方が準備するとラウンドが始まる。');
  send({ type: 'READY' });
});

el.calib.addEventListener('click', () => {
  el.calib.textContent = '計測中…';
  setTimeout(() => {
    const res = clockResolution();
    el.mRes.textContent = res != null ? res.toFixed(4) + ' ms' : '—';
    send({
      type: 'CALIB',
      clockResolution: res,
      frameIntervalMedian: median(frameIntervals),
      frameIntervalP95: percentile(frameIntervals, 0.95),
      rtt: rttStats(),
      dpr: devicePixelRatio,
      cores: navigator.hardwareConcurrency ?? null,
      screen: `${screen.width}x${screen.height}`,
    });
  }, 30);
});

el.dl.addEventListener('click', () => {
  const cols = ['ts', 'roundId', 'result', 'R', 'claimedR', 'Rsource', 'recorded', 'opponentR', 'diff', 'recvToPaint',
    'inputToHandler', 'frameInterval', 'serverElapsed', 'residual', 'w', 'reason'];
  const csv = [cols.join(',')].concat(
    localRows.map((r) => cols.map((c) => {
      const v = r[c] ?? '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')),
  ).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `reaction-lab-${params.name}-${Date.now()}.csv`;
  a.click();
});

connect();
