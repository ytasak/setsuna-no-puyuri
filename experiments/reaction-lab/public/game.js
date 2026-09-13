// 刹那のぷゆり — プレイ用プロトタイプ
//
// 設計は docs/set2-5-ui.md。計測は docs/set2-4-sync-fairness.md §2。
//   t_display = t_paint + フレーム間隔（推定） /  R = t_input − t_display
//
// 演出の原則:
//   合図より「前」— 合図の時刻を予告するものを一切置かない。だから対峙は静止させる。
//                    ただし静止と空白は違う。対峙している構図そのものが緊張になる。
//   合図の「瞬間」— rAF 1回で描き切る。transition もアニメーションも挟まない。
//   合図より「後」— 完全に自由。決着はここで派手にやる。計測には一切影響しない。

'use strict';

const qs = new URLSearchParams(location.search);
const params = {
  room: qs.get('room') || 'play',
  name: qs.get('name') || 'ぷゆ' + Math.random().toString(36).slice(2, 5),
};

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), arena: $('arena'), me: $('me'), foe: $('foe'),
  cue: $('cue'), lead: $('lead'), times: $('times'), sub: $('sub'),
  action: $('action'), status: $('status'), mute: $('mute'),
};
const faceTagMe = el.me.querySelector('.tag');
const faceTagFoe = el.foe.querySelector('.tag');

// ---------------------------------------------------------------- 音
//
// 合図では鳴らさない。端末ごとの音声遅延が読めず、視覚より先に出ると不公平になるため。
// 鳴らすのは決着の瞬間だけ。素材ファイルは使わず WebAudio で生成する。

const sound = {
  ctx: null, on: true,
  unlock() {
    if (this.ctx) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; }
  },
  // 斬撃。帯域を絞ったノイズを一瞬だけ
  slash() {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.12);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    const src = c.createBufferSource(); src.buffer = buf;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.8;
    const g = c.createGain(); g.gain.setValueAtTime(0.32, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    src.connect(bp).connect(g).connect(c.destination); src.start(t);
  },
  tone(freq, dur, type = 'sine', vol = 0.18, delay = 0) {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  },
  /** 着弾の衝撃。低い帯域のノイズ */
  impact() {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;
    const len = Math.floor(c.sampleRate * 0.3);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = c.createBufferSource(); src.buffer = buf;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    const g = c.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(lp).connect(g).connect(c.destination); src.start(t);
  },
  win()  { this.slash(); this.impact(); this.tone(784, 0.1, 'square', 0.09, 0.1); this.tone(1175, 0.14, 'square', 0.08, 0.18); this.tone(1568, 0.26, 'triangle', 0.1, 0.26); },
  lose() { this.slash(); this.impact(); this.tone(196, 0.14, 'sawtooth', 0.1, 0.1); this.tone(110, 0.5, 'sine', 0.24, 0.2); },
  draw() { this.slash(); this.tone(523, 0.18, 'triangle', 0.11); this.tone(523, 0.24, 'triangle', 0.09, 0.2); },
  ok() { return this.on && this.ctx && this.ctx.state !== 'suspended'; },
};
el.mute.addEventListener('click', (e) => {
  e.stopPropagation();
  sound.on = !sound.on;
  el.mute.textContent = sound.on ? '♪ オン' : '♪ オフ';
});

// ---------------------------------------------------------------- 計測

const frameTs = [];
let frameIntervals = [16.7];
requestAnimationFrame(function loop(ts) {
  frameTs.push(ts);
  if (frameTs.length > 61) frameTs.shift();
  if (frameTs.length > 1) {
    frameIntervals = [];
    for (let i = 1; i < frameTs.length; i++) frameIntervals.push(frameTs[i] - frameTs[i - 1]);
  }
  requestAnimationFrame(loop);
});
function median(a) {
  if (!a.length) return 16.7;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function inputTime(e, fallback) {
  const ts = e.timeStamp;
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return fallback;
  if (Math.abs(ts - fallback) > 60000) return fallback;
  return ts;
}

// ---------------------------------------------------------------- 状態

const st = {
  phase: 'connecting',
  matchId: null, roundId: null, clientId: null, peer: null, started: false,
  tRecv: null, tPaint: null, tDisplay: null, frameInterval: null,
  extraTaps: 0, visibilityOk: true, lockUntil: 0,
};
let ws = null, eventSeq = 0;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && ['armed', 'cue'].includes(st.phase)) st.visibilityOk = false;
});

// ---------------------------------------------------------------- 画面

function clearStrike() {
  el.stage.classList.remove('strike', 'left');
  for (const f of [el.me, el.foe]) f.classList.remove('blown', 'zanshin');
}

function render({ phase, lead, sub = '', action = null, times = null, leadClass = '', arena = false, cue = false }) {
  st.phase = phase;
  el.stage.className = ['armed', 'cue', 'result'].includes(phase) ? phase : '';
  el.arena.hidden = !arena;
  el.cue.hidden = !cue;
  el.lead.textContent = lead;
  el.lead.className = leadClass;
  el.sub.textContent = sub;
  el.times.hidden = !times;
  if (times) el.times.innerHTML = times.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');
  if (action) { el.action.hidden = false; el.action.textContent = action.label; el.action.onclick = action.onClick; }
  else { el.action.hidden = true; el.action.onclick = null; }
}

const setStatus = (text, ok) => { el.status.innerHTML = `<span class="dot${ok ? ' on' : ''}"></span> ${text}`; };

function showRules() {
  clearStrike();
  render({
    phase: 'rules', lead: '刹那のぷゆり',
    sub: '「ぷゆ！」が出たら、すぐ押す。\n出る前に押すと負け。',
    action: { label: 'はじめる', onClick: () => { sound.unlock(); st.started = true; showLobby(); } },
  });
  el.sub.classList.add('rule');
}

function showLobby() {
  clearStrike();
  el.sub.classList.remove('rule');
  if (st.matchId && st.peer) {
    faceTagFoe.textContent = st.peer;
    render({
      phase: 'matched', lead: '対 峙', sub: `${st.peer} と向かい合った。`,
      arena: true, action: { label: '構える', onClick: sendReady },
    });
  } else {
    render({ phase: 'waiting', lead: '相手を探しています', sub: 'もうひとり来るのを待っています。' });
  }
}

function sendReady() {
  send({ type: 'READY', matchId: st.matchId });
  clearStrike();
  render({ phase: 'ready', lead: '構えた', sub: '相手が構えるのを待っています。', arena: true });
}

// ---------------------------------------------------------------- 通信

function send(msg) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ eventId: ++eventSeq, ...msg }));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ room: params.room, mode: 'duel', name: params.name });
  ws = new WebSocket(`${proto}://${location.host}/?${q}`);
  ws.onopen = () => setStatus('接続済み', true);
  ws.onclose = () => {
    setStatus('切断（再接続しています）', false);
    render({ phase: 'error', lead: '通信が切れました', sub: '再接続しています…' });
    st.matchId = null; st.peer = null; st.started = false;
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMessage(m); };
}

function onMessage(m) {
  switch (m.type) {
    case 'WELCOME': st.clientId = m.clientId; showRules(); break;
    case 'FULL': render({ phase: 'error', lead: 'この部屋は満員です', sub: '別の部屋を開いてください。' }); break;
    case 'MATCHED':
      st.matchId = m.matchId;
      st.peer = (m.peer ?? [])[0] ?? 'あいて';
      if (st.started) showLobby();
      break;
    case 'STATE': if (m.matchId) st.matchId = m.matchId; break;
    case 'PEER_LEFT':
      st.peer = null;
      render({ phase: 'peerleft', lead: '相手が去った', sub: '次の相手を待っています。' });
      break;
    case 'ARMED': onArmed(m); break;
    case 'GO': onGo(m); break;
    case 'RESULT': onResult(m); break;
    case 'SPING': send({ type: 'SPONG', seq: m.seq }); break;
  }
}

// ---------------------------------------------------------------- 対峙と合図

function onArmed(m) {
  st.matchId = m.matchId ?? st.matchId;
  st.roundId = m.roundId;
  st.tRecv = st.tPaint = st.tDisplay = null;
  st.extraTaps = 0;
  st.visibilityOk = document.visibilityState === 'visible';
  clearStrike();
  // 対峙は静止させる。動くもの・変わるものは一切置かない。
  // ただし空白にはしない。向かい合っている構図そのものが緊張になる。
  render({ phase: 'armed', lead: 'ま だ', sub: '', arena: true });
}

function onGo(m) {
  if (m.roundId !== st.roundId) return;
  st.tRecv = performance.now();
  st.phase = 'cuePending';
  requestAnimationFrame((ts) => {
    // この rAF が t_paint。transition もアニメーションも挟まないので表示時刻が定義できる
    st.tPaint = ts;
    st.frameInterval = median(frameIntervals);
    st.tDisplay = ts + st.frameInterval;
    // 対峙の構図はそのまま。舞台が明るくなり、画面の中央に合図が出る
    el.stage.className = 'cue';
    el.cue.hidden = false;
    el.lead.textContent = '';
    el.lead.className = '';
    el.sub.textContent = '';
    el.times.hidden = true;
    el.action.hidden = true;
    st.phase = 'cue';
  });
}

// ---------------------------------------------------------------- 入力

function handleInput(tInput, tHandler) {
  if (performance.now() < st.lockUntil) return;

  if (st.phase === 'armed' || st.phase === 'cuePending') {
    send({ type: 'TAP', matchId: st.matchId, roundId: st.roundId, flying: true, rtt: {} });
    render({ phase: 'sent', lead: '抜いた', sub: '早い。相手を待っています。', arena: true });
    return;
  }
  if (st.phase !== 'cue') { st.extraTaps++; return; }

  const R = tInput - st.tDisplay;
  if (R < 0) {
    send({ type: 'TAP', matchId: st.matchId, roundId: st.roundId, flying: true, rtt: {} });
    render({ phase: 'sent', lead: '抜いた', sub: '早い。相手を待っています。', arena: true });
    return;
  }
  send({
    type: 'TAP', matchId: st.matchId, roundId: st.roundId, flying: false, R,
    recvToPaint: st.tPaint - st.tRecv, inputToHandler: tHandler - tInput,
    frameInterval: st.frameInterval, visibilityOk: st.visibilityOk,
    extraTaps: st.extraTaps, rtt: {},
  });
  st.phase = 'sent';
  el.lead.textContent = `${R.toFixed(0)} ms`;
  el.sub.textContent = '相手を待っています。';
}

el.stage.addEventListener('pointerdown', (e) => {
  if (e.target === el.action || e.target === el.mute) return;
  const tHandler = performance.now();
  handleInput(inputTime(e, tHandler), tHandler);
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  if (e.repeat) return;
  e.preventDefault();
  const tHandler = performance.now();
  handleInput(inputTime(e, tHandler), tHandler);
});

// ---------------------------------------------------------------- 決着

const VERDICT = {
  win:  { label: '勝ち', mark: '○', cls: 'win' },
  lose: { label: '負け', mark: '×', cls: 'lose' },
  draw: { label: '相打ち', mark: '－', cls: 'draw' },
  void: { label: 'ノーゲーム', mark: '－', cls: 'draw' },
  solo: { label: '計測のみ', mark: '－', cls: 'draw' },
};

function reasonText(mine, other) {
  if (mine.flying) return '合図の前に抜いた';
  if (mine.tooFast) return '合図より前に反応している';
  if (mine.disconnected) return '通信が切断されました';
  if (other?.disconnected) return 'あいての通信が切断されました';
  if (mine.noInput && other?.noInput) return 'どちらも抜かなかった';
  if (mine.noInput) return '抜けなかった';
  if (other?.noInput) return 'あいてが抜かなかった';
  if (mine.result === 'draw') return 'ほぼ同時';
  if (other?.flying || other?.tooFast) return 'あいてが合図の前に抜いた';
  if (mine.result === 'lose') return 'わずかに遅かった';
  return '';
}

function onResult(m) {
  const mine = m.players.find((p) => p.id === st.clientId) ?? m.players[0];
  const other = m.players.find((p) => p.id !== mine.id);
  const v = VERDICT[mine.result] ?? VERDICT.draw;

  const fmt = (p) => {
    if (!p) return '—';
    if (p.flying || p.tooFast) return '早すぎ';
    if (p.noInput) return '抜かず';
    if (p.disconnected) return '切断';
    return p.R != null ? `${p.R.toFixed(0)} ms` : '—';
  };

  const notes = [reasonText(mine, other)];
  if (mine.Rsource === 'server-estimate') notes.push('この端末の計測値は使われませんでした');
  if (m.recorded === false) notes.push('この試合は記録されません');

  st.lockUntil = performance.now() + 600;
  clearStrike();
  faceTagFoe.textContent = st.peer ?? 'あいて';
  render({
    phase: 'result', lead: `${v.mark} ${v.label}`, leadClass: v.cls,
    times: [['あなた', fmt(mine)], [st.peer ?? 'あいて', fmt(other)]],
    sub: notes.filter(Boolean).join('\n'), arena: true,
  });

  // 合図より後なので自由に動かせる。閃光 → 斬撃 → 敗者が吹き飛ぶ → 勝者が残心
  requestAnimationFrame(() => {
    if (mine.result === 'win') {
      el.stage.classList.add('strike');              // 斬撃は自分（左）から相手（右）へ
      el.foe.classList.add('blown'); el.me.classList.add('zanshin');
      sound.win();
    } else if (mine.result === 'lose') {
      el.stage.classList.add('strike', 'left');      // 相手（右）から自分（左）へ
      el.me.classList.add('blown'); el.foe.classList.add('zanshin');
      sound.lose();
    } else {
      el.stage.classList.add('strike');
      sound.draw();
    }
  });

  setTimeout(() => {
    if (st.phase !== 'result') return;
    el.action.hidden = false;
    el.action.textContent = 'もう一度';
    el.action.onclick = sendReady;
  }, 600);
}

setStatus('接続しています', false);
connect();
