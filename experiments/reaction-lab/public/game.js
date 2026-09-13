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
  mine: $('mine'), board: $('board'), rankFast: $('rankFast'), rankStreak: $('rankStreak'),
  resetIn: $('resetIn'), boardClose: $('boardClose'),
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
  ok() { return this.on && this.ctx && this.ctx.state !== 'suspended'; },

  /**
   * 全部の音をここに通す。層を重ねると振幅が足し合わさって 1.0 を超えるので、
   * まとめて下げておく。
   *
   * **コンプレッサーを挟んではいけない。** 一度試したが、
   * Web Audio の DynamicsCompressor には固有の先読み遅延（Chrome で約6ms）があり、
   * さらに立ち上がりを潰す。実測で合図の頭が 0ms から 20ms 先へずれ、
   * 0〜5ms の振幅が完全に消えた。合図の音はアタックがすべてなので、
   * 音量を稼ぐために transient を犠牲にする処理とは相性が最悪。
   * 割れるなら各層のゲインを下げること。
   */
  master() {
    if (!this._bus || this._bus.context !== this.ctx) {
      const g = this.ctx.createGain();
      g.gain.value = 0.62;
      g.connect(this.ctx.destination);
      this._bus = g;
    }
    return this._bus;
  },

  /**
   * ノイズを1発作る。
   * @param dur   長さ[秒]
   * @param decay 減衰の鋭さ。大きいほど頭だけ残って尻が消える
   */
  noise(dur, decay) {
    const c = this.ctx;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    const src = c.createBufferSource();
    src.buffer = buf;
    return src;
  },

  /**
   * 減衰するゲイン。立ち上がりに ramp を使わないのは、鈍らせると「いつ鳴ったか」が
   * 曖昧になるため。
   *
   * 落とす先を 0.0001 にすると -80dB 超の減衰になり、体感の長さが dur の 1/3 になる。
   * -36dB まで落としてから切ることで、dur がそのまま「鳴っている長さ」になる。
   */
  env(v, dur, at) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, at);
    g.gain.exponentialRampToValueAtTime(v * 0.015, at + dur);
    g.gain.linearRampToValueAtTime(0, at + dur * 1.1);
    return g;
  },

  /**
   * 合図の音「ドンッ」
   *
   * 太鼓。低い胴の鳴りが主だが、それだけだと「いつ鳴ったか」が曖昧になる。
   * 低音は耳が時間を捉えにくいので、バチが皮を叩く高めの音を頭に一瞬だけ置く。
   * 実際の太鼓もこの2層でできている。合図として使う以上、頭の鋭さは外せない。
   *
   * 胴の高さを 60Hz 台まで下げると本物には近いが、スマホのスピーカーでは
   * ほとんど再生されない。少し高めに置いて、倍音で太さを補う。
   */
  cue() {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;
    // ここを触ると音色が変わる
    const HIT = 1800;   // バチが当たる音の帯域。上げると硬く、下げると鈍くなる
    const BODY = 150;   // 胴の鳴りはじめの高さ。下げるほど大きな太鼓になる
    const DROP = 72;    // 落ち着く高さ
    const LEN = 0.24;   // 鳴っている長さ[秒]

    // バチ。頭を 0ms に立てるためだけの層。短く切る。
    // 帯域を絞りすぎるとエネルギーが痩せて胴鳴りに埋もれ、合図の頭が消える
    const stick = this.noise(0.022, 1.2);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = HIT; bp.Q.value = 0.45;
    stick.connect(bp).connect(this.env(1.3, 0.02, t)).connect(this.master());
    stick.start(t);

    // 胴。張った皮が緩むぶん、ピッチが少し落ちる
    const body = c.createOscillator(); body.type = 'sine';
    body.frequency.setValueAtTime(BODY, t);
    body.frequency.exponentialRampToValueAtTime(DROP, t + 0.09);
    body.connect(this.env(0.58, LEN, t)).connect(this.master());
    body.start(t); body.stop(t + LEN * 1.2);

    // 倍音。小さいスピーカーでも胴の高さが伝わるように
    const ov = c.createOscillator(); ov.type = 'triangle';
    ov.frequency.setValueAtTime(BODY * 2, t);
    ov.frequency.exponentialRampToValueAtTime(DROP * 2, t + 0.09);
    ov.connect(this.env(0.15, LEN * 0.45, t)).connect(this.master());
    ov.start(t); ov.stop(t + LEN);
  },

  /**
   * 斬撃の音「バシィ」
   *
   *   バ … 低域の打撃。当たった瞬間の重さ
   *   シィ … 高域の擦過。わずかに遅らせて、長めに伸ばして引く
   *
   * この2層をずらして重ねると「バシィ」になる。
   * 片方だけだと「ドッ」か「シュッ」にしかならない。
   */
  slash() {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;

    // 当たった瞬間の割れ。フィルタを通さない帯域を一瞬だけ置いて、頭を 0ms に立てる。
    // 低域だけだとフィルタの応答で山が 15ms あたりにずれ、打撃が鈍る
    const crack = this.noise(0.018, 1.6);
    const cbp = c.createBiquadFilter(); cbp.type = 'bandpass'; cbp.frequency.value = 2400; cbp.Q.value = 0.6;
    crack.connect(cbp).connect(this.env(0.5, 0.018, t)).connect(this.master());
    crack.start(t);

    // バ（打撃）
    const hit = this.noise(0.1, 1.2);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 820;
    hit.connect(lp).connect(this.env(0.7, 0.09, t)).connect(this.master());
    hit.start(t);
    // 胴鳴り。ピッチを落として重さを出す
    const body = c.createOscillator(); body.type = 'sine';
    body.frequency.setValueAtTime(230, t);
    body.frequency.exponentialRampToValueAtTime(52, t + 0.11);
    body.connect(this.env(0.33, 0.13, t)).connect(this.master());
    body.start(t); body.stop(t + 0.15);

    // シィ（擦過）。6ms 遅らせて尾を長く引く。
    // 高域へ振り切ると energy が痩せて尾が消えるので、上は 4kHz までに留める
    const t2 = t + 0.006;
    const hiss = this.noise(0.45, 0.5);
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.setValueAtTime(1800, t2);
    hp.frequency.exponentialRampToValueAtTime(4000, t2 + 0.34);
    hiss.connect(hp).connect(this.env(0.45, 0.4, t2)).connect(this.master());
    hiss.start(t2);
  },

  tone(freq, dur, type = 'sine', vol = 0.18, delay = 0) {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    o.connect(this.env(vol, dur, t)).connect(this.master());
    o.start(t); o.stop(t + dur + 0.02);
  },

  win()  { this.slash(); this.tone(784, 0.1, 'square', 0.09, 0.14); this.tone(1175, 0.13, 'square', 0.08, 0.22); this.tone(1568, 0.26, 'triangle', 0.1, 0.3); },
  lose() { this.slash(); this.tone(196, 0.14, 'sawtooth', 0.09, 0.14); this.tone(110, 0.5, 'sine', 0.22, 0.24); },
  draw() { this.slash(); this.tone(523, 0.18, 'triangle', 0.1, 0.14); },
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
  me: null,              // その日限りの二つ名
  daily: null, ranking: null, cookieReceived: true, resetAt: null,
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
  renderMine();
}

const setStatus = (text, ok) => { el.status.innerHTML = `<span class="dot${ok ? ' on' : ''}"></span> ${text}`; };

function showRules() {
  clearStrike();
  render({
    phase: 'rules', lead: '刹那のぷゆり',
    sub: '「ぷゆ！」が出たら、すぐ押す。\n出る前に押すと負け。',
    action: { label: 'はじめる', onClick: () => { sound.unlock(); st.started = true; joinQueue(); } },
  });
  el.sub.classList.add('rule');
}

function joinQueue() {
  send({ type: 'JOIN' });
  clearStrike();
  el.sub.classList.remove('rule');
  render({ phase: 'waiting', lead: '相手を探しています', sub: '見つかるまで少し待ちます。' });
}

// ---------------------------------------------------------------- 当日の記録

function applyStats(m) {
  if (m.daily) st.daily = m.daily;
  if (m.ranking) st.ranking = m.ranking;
}

function renderMine() {
  const d = st.daily;
  const bits = [];
  if (st.me) bits.push(`<span>${st.me}</span>`);
  if (d) {
    bits.push(`<span>連勝 <b>${d.streak}</b></span>`);
    bits.push(`<span>最速 <b>${d.bestR === null ? '—' : d.bestR + 'ms'}</b></span>`);
    bits.push(`<span>${d.win}勝 ${d.lose}敗</span>`);
  }
  // Cookie が保存されない環境では記録が積み上がらない（SET2-6 §3.3）
  if (!st.cookieReceived) bits.push('<span class="warn">この環境では記録が残りません</span>');
  bits.push('<span><a href="#" id="openBoard" style="color:inherit">きょうの記録</a></span>');
  el.mine.innerHTML = bits.join('');
  const open = document.getElementById('openBoard');
  if (open) open.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showBoard(); };
}

function renderBoard() {
  const r = st.ranking;
  const row = (x, i) => `<li class="${x.name === st.me ? 'me' : ''}">`
    + `<span class="r">${i + 1}</span><span class="n">${x.name}</span>`
    + `<span class="v">${x.value}${x.unit ?? ''}</span></li>`;
  const fill = (ol, list, unit) => {
    ol.innerHTML = list.length
      ? list.map((x, i) => row({ ...x, unit }, i)).join('')
      : '<li class="empty">まだ記録がありません</li>';
  };
  fill(el.rankFast, r?.fastest ?? [], 'ms');
  fill(el.rankStreak, r?.streak ?? [], '');
  const left = Math.max(0, (st.resetAt ?? 0) - Date.now());
  const h = Math.floor(left / 3600000), mi = Math.floor(left / 60000) % 60;
  el.resetIn.textContent = `記録は毎日 0 時にリセットされます（あと ${h}時間${mi}分）`;
}

function showBoard() { send({ type: 'STATS_REQ' }); renderBoard(); el.board.hidden = false; }
el.boardClose.addEventListener('click', (e) => { e.stopPropagation(); el.board.hidden = true; });
el.board.addEventListener('pointerdown', (e) => e.stopPropagation());

function showLobby() {
  clearStrike();
  el.sub.classList.remove('rule');
  if (st.matchId && st.peer) {
    faceTagFoe.textContent = st.peer;
    faceTagMe.textContent = st.me ?? 'あなた';
    render({
      phase: 'matched', lead: '対 峙', sub: `${st.peer} と向かい合った。`,
      arena: true, action: { label: '構える', onClick: sendReady },
    });
  } else {
    render({ phase: 'waiting', lead: '相手を探しています', sub: 'もうひとり来るのを待っています。' });
  }
}

function sendReady() {
  // 書体の読み込み中にラウンドが始まると、合図の字形が途中で入れ替わりうる。
  // 描画が遅れて計測に影響するのを避けるため、載りきってから構えさせる
  if (document.fonts && document.fonts.status !== 'loaded') {
    el.action.hidden = true;
    document.fonts.ready.then(sendReady);
    return;
  }
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
  // 待機列に入る。部屋名は使わない（docs/set2-3-matchmaking.md）
  const q = new URLSearchParams({ mode: 'queue' });
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
    case 'WELCOME':
      st.clientId = m.clientId;
      st.me = m.you;
      st.cookieReceived = m.cookieReceived;
      st.resetAt = Date.now() + (m.msUntilReset ?? 0);
      applyStats(m);
      showRules();
      break;
    case 'STATS': applyStats(m); renderMine(); if (!el.board.hidden) renderBoard(); break;
    case 'QUEUED':
      render({ phase: 'waiting', lead: '相手を探しています', sub: '見つかるまで少し待ちます。' });
      break;
    case 'QUEUE_REJECTED':
      render({ phase: 'error', lead: '別のタブで参加しています',
        sub: '同時に参加できるのは1つまでです。' });
      break;
    case 'WAIT_TIMEOUT':
      render({ phase: 'waiting', lead: '相手が見つかりませんでした', sub: '',
        action: { label: 'もう一度さがす', onClick: joinQueue } });
      break;
    case 'READY_TIMEOUT':
      st.matchId = null; st.peer = null;
      render({ phase: 'waiting', lead: '相手が構えませんでした', sub: '',
        action: { label: 'もう一度さがす', onClick: joinQueue } });
      break;
    case 'FULL': render({ phase: 'error', lead: 'この部屋は満員です', sub: '別の部屋を開いてください。' }); break;
    case 'MATCHED':
      st.matchId = m.matchId;
      st.peer = (m.peer ?? [])[0] ?? 'あいて';
      if (m.you) st.me = m.you;
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
    // 描画を書き終えてから鳴らす。音の生成で paint を遅らせない
    sound.cue();
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
  if (m.recorded === false) notes.push('この試合は記録されません');

  st.lockUntil = performance.now() + 600;
  clearStrike();
  faceTagFoe.textContent = st.peer ?? 'あいて';
  faceTagMe.textContent = st.me ?? 'あなた';
  render({
    phase: 'result', lead: `${v.mark} ${v.label}`, leadClass: v.cls,
    times: [[st.me ?? 'あなた', fmt(mine)], [st.peer ?? 'あいて', fmt(other)]],
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
    el.action.onclick = joinQueue;   // 1試合ごとに列へ戻る。連勝は切れない
  }, 600);
}

setStatus('接続しています', false);
connect();
