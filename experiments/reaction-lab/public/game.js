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

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), arena: $('arena'), me: $('me'), foe: $('foe'),
  cue: $('cue'), lead: $('lead'), times: $('times'), sub: $('sub'),
  actions: $('actions'), mute: $('mute'),
  mine: $('mine'), board: $('board'), rankFast: $('rankFast'),
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

/** 結果の中で自分と相手を指す id */
const ME = 'me', FOE = 'foe';

const st = {
  phase: 'rules',
  roundId: null, peer: null,
  me: null,              // その日限りの二つ名
  daily: null, ranking: null, cookieReceived: true, online: true, resetAt: null,
  tDisplay: null,        // 合図が画面に出た時刻（推定）。R の基準
  lockUntil: 0,
  dojo: null,            // 道場にいるあいだだけ入る（下の「道場」節）
};

// ---------------------------------------------------------------- 画面

function clearStrike() {
  el.stage.classList.remove('strike', 'left');
  for (const f of [el.me, el.foe]) f.classList.remove('fallen', 'zanshin', 'iai');
}

/**
 * 選択肢を出す。1つでも複数でも同じ形で渡せる。
 * `variant: 'sub'` を付けたものは控えめな見た目になる（押し間違い対策）
 */
function setActions(action) {
  const list = action ? (Array.isArray(action) ? action : [action]) : [];
  el.actions.replaceChildren();
  el.actions.hidden = list.length === 0;
  for (const a of list) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.variant) b.className = a.variant;
    b.onclick = a.onClick;
    el.actions.appendChild(b);
  }
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
  setActions(action);
  renderMine();
}

function showRules() {
  // ここはタイトル。道場から出た状態へ戻す
  leaveDojo();
  clearStrike();
  render({
    phase: 'rules', lead: '刹那のぷゆり',
    sub: '「ぷゆ！」が出たら、すぐ押す。\n出る前に押すと負け。',
    action: { label: 'はじめる', onClick: () => { sound.unlock(); enterDojo(); } },
  });
  el.sub.classList.add('rule');
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
    bits.push(`<span>最速 <b>${d.bestR === null ? '—' : d.bestR + 'ms'}</b></span>`);
    bits.push(`<span>${d.win}勝 ${d.lose}敗</span>`);
  }
  // Cookie が保存されない環境では記録が積み上がらない（SET2-6 §3.3）
  if (!st.cookieReceived) bits.push('<span class="warn">この環境では記録が残りません</span>');
  else if (!st.online) bits.push('<span class="warn">記録につながりませんでした</span>');
  bits.push('<span><a href="#" id="openBoard" style="color:inherit">きょうの記録</a></span>');
  el.mine.innerHTML = bits.join('');
  const open = document.getElementById('openBoard');
  if (open) open.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showBoard(); };
}

function renderBoard() {
  const list = st.ranking?.fastest ?? [];
  const row = (x, i) => `<li class="${x.name === st.me ? 'me' : ''}">`
    + `<span class="r">${i + 1}</span><span class="n">${x.name}</span>`
    + `<span class="v">${x.value}ms</span></li>`;
  el.rankFast.innerHTML = list.length
    ? list.map(row).join('')
    : '<li class="empty">まだ記録がありません</li>';
  const left = Math.max(0, (st.resetAt ?? 0) - Date.now());
  const h = Math.floor(left / 3600000), mi = Math.floor(left / 60000) % 60;
  el.resetIn.textContent = `記録は毎日 0 時にリセットされます（あと ${h}時間${mi}分）`;
}

function showBoard() { refreshMe(); renderBoard(); el.board.hidden = false; }
el.boardClose.addEventListener('click', (e) => { e.stopPropagation(); el.board.hidden = true; });
el.board.addEventListener('pointerdown', (e) => e.stopPropagation());

function sendReady() {
  // 書体の読み込み中にラウンドが始まると、合図の字形が途中で入れ替わりうる。
  // 描画が遅れて計測に影響するのを避けるため、載りきってから構えさせる
  if (document.fonts && document.fonts.status !== 'loaded') {
    setActions(null);
    document.fonts.ready.then(sendReady);
    return;
  }
  dojoSend({ type: 'READY' });
  clearStrike();
  render({ phase: 'ready', lead: '構えた', sub: '相手が構えるのを待っています。', arena: true });
}

// ---------------------------------------------------------------- 通信
//
// 試合はブラウザの中だけで進むので、繋ぎっぱなしにする必要が無い。
// サーバーに用があるのは当日の記録だけで、口は2つしかない。
//
//   GET  /api/me     … 二つ名・自分の記録・最速ランキング
//   POST /api/result … 1ラウンドぶんの結果を記録する
//
// **どちらも失敗して構わない。** 記録が残らないだけで、遊ぶほうは止まらない。
// サーバーが落ちていても道場は最後まで動く。

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function applyMe(m) {
  if (m.you) st.me = m.you;
  st.cookieReceived = m.cookieReceived !== false;
  st.resetAt = Date.now() + (m.msUntilReset ?? 0);
  applyStats(m);
}

/** 自分まわりを取り直す。開いたときと、記録を見るときに呼ぶ */
async function refreshMe() {
  try { applyMe(await api('/api/me')); st.online = true; } catch { st.online = false; }
  renderMine();
  if (!el.board.hidden) renderBoard();
}

/** 1ラウンドぶん記録する。返ってくるのは /api/me と同じ形 */
async function report(round) {
  try { applyMe(await api('/api/result', round)); st.online = true; } catch { st.online = false; }
  renderMine();
}

/** 二重記録を防ぐためだけの使い捨ての id。連番にしない（開き直すと以前と衝突する） */
function newRoundId() {
  return crypto.randomUUID?.()
    ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
}

/** 道場が自分で作ったイベントを受ける口。ARMED / GO / RESULT の3つだけ */
function onMessage(m) {
  switch (m.type) {
    case 'ARMED': onArmed(m); break;
    case 'GO': onGo(m); break;
    case 'RESULT': onResult(m); break;
  }
}

// ---------------------------------------------------------------- 対峙と合図

function onArmed(m) {
  st.roundId = m.roundId;
  st.tDisplay = null;
  clearStrike();
  // 対峙は静止させる。動くもの・変わるものは一切置かない。
  // ただし空白にはしない。向かい合っている構図そのものが緊張になる。
  render({ phase: 'armed', lead: 'ま だ', sub: '', arena: true });
}

function onGo(m) {
  if (m.roundId !== st.roundId) return;
  st.phase = 'cuePending';
  requestAnimationFrame((ts) => {
    // この rAF が t_paint。transition もアニメーションも挟まないので表示時刻が定義できる
    st.tDisplay = ts + median(frameIntervals);
    // 対峙の構図はそのまま。舞台が明るくなり、画面の中央に合図が出る
    el.stage.className = 'cue';
    el.cue.hidden = false;
    el.lead.textContent = '';
    el.lead.className = '';
    el.sub.textContent = '';
    el.times.hidden = true;
    setActions(null);
    st.phase = 'cue';
    // 描画を書き終えてから鳴らす。音の生成で paint を遅らせない
    sound.cue();
  });
}

// ---------------------------------------------------------------- 入力

function handleInput(tInput) {
  if (performance.now() < st.lockUntil) return;

  if (st.phase === 'armed' || st.phase === 'cuePending') {
    dojoSend({ type: 'TAP', roundId: st.roundId, flying: true });
    render({ phase: 'sent', lead: '抜いた', sub: '早い。相手を待っています。', arena: true });
    return;
  }
  if (st.phase !== 'cue') return;

  const R = tInput - st.tDisplay;
  if (R < 0) {
    dojoSend({ type: 'TAP', roundId: st.roundId, flying: true });
    render({ phase: 'sent', lead: '抜いた', sub: '早い。相手を待っています。', arena: true });
    return;
  }
  dojoSend({ type: 'TAP', roundId: st.roundId, flying: false, R });
  st.phase = 'sent';
  el.lead.textContent = `${R.toFixed(0)} ms`;
  el.sub.textContent = '相手を待っています。';
}

el.stage.addEventListener('pointerdown', (e) => {
  if (el.actions.contains(e.target) || e.target === el.mute) return;
  const tHandler = performance.now();
  handleInput(inputTime(e, tHandler));
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  if (e.repeat) return;
  e.preventDefault();
  const tHandler = performance.now();
  handleInput(inputTime(e, tHandler));
});

// ---------------------------------------------------------------- 道場
//
// ゲーム本体。一段目から六段目まで、勝つたびに速い相手へ上がっていく。
// 相手の反応時間はその場で引いた乱数なので、**試合はこのブラウザの中で完結する**。
//
// ARMED / GO / RESULT を自分で作って onMessage に流す形は、対人戦だったころの
// 名残りだが、そのままにしてある。計測（handleInput）と演出（onResult）を
// 合図の作り手から切り離しておくと、どちらも読み書きしやすい。
//
// 判定は core/match.js の decide() を rules-bridge.js 経由でそのまま使う。
// ここで書き写すと必ず食い違う。

/** 段位。名前は「◯◯のぷゆ△」（人間）と別系統にして、人と見間違えないようにする */
const DOJO_RANKS = [
  { name: '藁の案山子',   mu: 360, sigma: 55 },
  { name: '丸太の門番',   mu: 305, sigma: 46 },
  { name: '白木の門下生', mu: 258, sigma: 38 },
  { name: '黒鉄の師範代', mu: 218, sigma: 31 },
  { name: '影の師範',     mu: 186, sigma: 25 },
  { name: '無名の名人',   mu: 162, sigma: 20 },
];
/** Box-Muller。相手の反応時間をばらつかせる。同じ段でも勝ったり負けたりする */
function gauss() {
  const u = Math.random() || 1e-9;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/**
 * 相手の反応時間。裾が伸びすぎないよう両端を止める。
 * 下限は人間の下限のつもりで置いているだけで、判定には何の意味も無い
 */
function dojoSampleR(rank) {
  const r = rank.mu + gauss() * rank.sigma;
  return Math.min(900, Math.max(110, r));
}

const dojoRules = () => window.__puyuriRules ?? null;

function leaveDojo() {
  if (!st.dojo) return;
  for (const t of st.dojo.timers) clearTimeout(t);
  st.dojo = null;
  st.peer = null;
}

function enterDojo() {
  const rules = dojoRules();
  if (!rules) {           // 判定規則を読めていない。本物と違う基準で遊ばせない
    render({ phase: 'error', lead: '道場を開けませんでした',
      sub: '読み込みし直してください。',
      action: { label: 'タイトルへ', onClick: showRules } });
    return;
  }
  leaveDojo();
  st.dojo = {
    // 段位は持ち越さない。入るたびに一段目から。
    // 保存すると次に来たときには最後の相手しか残っておらず、登る楽しみが消える
    rank: 0, cfg: { ...rules.DEFAULT_CFG },
    roundId: 0, timers: [], rec: null, botR: null,
  };
  dojoFacing();
}

/** 対峙の画面 */
function dojoFacing() {
  const d = st.dojo;
  const rank = DOJO_RANKS[d.rank];
  st.peer = rank.name;
  clearStrike();
  el.sub.classList.remove('rule');
  render({
    phase: 'ready', lead: '対 峙', sub: `${d.rank + 1}段　${rank.name}`, arena: true,
    action: [
      { label: '構える', onClick: sendReady },
      { label: 'タイトルへ', onClick: showRules, variant: 'sub' },
    ],
  });
  faceTagFoe.textContent = rank.name;
  faceTagMe.textContent = st.me ?? 'あなた';
}

const dojoTimer = (fn, ms) => st.dojo?.timers.push(setTimeout(fn, ms));

/** サーバーの代わり。game.js が送ったつもりのメッセージをここで受ける */
function dojoSend(msg) {
  const d = st.dojo;
  if (!d) return;
  if (msg.type === 'READY') {
    // すぐ ARMED にすると、sendReady が自分で出す「構えた」に上書きされてしまう。
    // st.phase が armed にならないと、合図前の入力がフライング扱いにならない。
    // 相手が構えるまでの間合いも兼ねて、少し置いてから始める
    return dojoTimer(dojoArm, 220 + Math.random() * 260);
  }
  if (msg.type !== 'TAP' || !d.rec || msg.roundId !== d.roundId) return;
  if (d.rec.me) return;                       // 連打。最初の1回だけ採用する
  d.rec.me = msg.flying
    ? { flying: true, R: null }
    : { flying: false, R: msg.R };

  // **同期で判定してはいけない。** ここは handleInput の send() の中なので、
  // そのまま RESULT まで走ると、結果を描いたあとに handleInput の続きが
  // st.phase を 'sent' に戻し、600ms 後にボタンを出す処理が弾かれて進行が止まる。
  // 相手が先に抜いていた場合（負けとほぼ同着）に必ず起きる。
  // 呼び出し元が描き終わるのを待ってから判定する
  dojoTimer(dojoResolve, 0);
}

function dojoArm() {
  const d = st.dojo;
  for (const t of d.timers) clearTimeout(t);
  d.timers = [];
  d.roundId += 1;
  d.rec = { me: null, bot: null };
  d.botR = dojoSampleR(DOJO_RANKS[d.rank]);

  const w = d.cfg.wMin + Math.random() * (d.cfg.wMax - d.cfg.wMin);
  onMessage({ type: 'ARMED', roundId: d.roundId });
  dojoTimer(() => {
    onMessage({ type: 'GO', roundId: d.roundId });
    // 相手は合図から botR 後に抜く
    dojoTimer(() => { if (d.rec && !d.rec.bot) { d.rec.bot = { flying: false, R: d.botR }; dojoResolve(); } }, d.botR);
    // 入力期限。押さなければ無入力で決着する
    dojoTimer(() => {
      if (!d.rec) return;
      if (!d.rec.me) d.rec.me = { noInput: true, R: null };
      if (!d.rec.bot) d.rec.bot = { flying: false, R: d.botR };
      dojoResolve();
    }, d.cfg.inputDeadline);
  }, w);
}

/** 両者そろったら判定する */
function dojoResolve() {
  const d = st.dojo;
  if (!d?.rec || !d.rec.me || !d.rec.bot) return;
  const { decide } = dojoRules();
  const rec = d.rec;
  d.rec = null;
  for (const t of d.timers) clearTimeout(t);
  d.timers = [];

  const side = (r) => ({
    flying: !!r.flying, noInput: !!r.noInput,
    R: typeof r.R === 'number' ? Math.round(r.R * 100) / 100 : null,
  });
  const me = side(rec.me), foe = side(rec.bot);
  const result = decide(me, foe);

  onMessage({
    type: 'RESULT', roundId: d.roundId,
    players: [
      { id: ME, name: st.me ?? 'あなた', result, ...me },
      { id: FOE, name: DOJO_RANKS[d.rank].name, result: result === 'win' ? 'lose' : 'win', ...foe },
    ],
  });
  report({ id: newRoundId(), result, R: me.R, flying: me.flying, noInput: me.noInput });
}

/** 決着の理由を消さずに、一行足す */
function dojoNote(line) {
  el.sub.textContent = [el.sub.textContent, line].filter(Boolean).join('\n');
}

/** 決着のあとの選択肢。勝てば次の段へ進む */
function dojoAfter(mine) {
  const d = st.dojo;
  const last = d.rank >= DOJO_RANKS.length - 1;
  const back = { label: 'タイトルへ', onClick: showRules, variant: 'sub' };

  if (mine.result === 'win') {
    if (last) {
      // 最後まで登りきった。ここで終わり。挑み直すならまた一段目から
      dojoNote('免許皆伝。すべての相手を破った。');
      return setActions([{ ...back, label: 'タイトルへ', variant: '' }]);
    }
    d.rank += 1;
    dojoNote(`${d.rank + 1}段　${DOJO_RANKS[d.rank].name} が待っている。`);
    return setActions([{ label: '次の相手', onClick: dojoFacing }, back]);
  }
  // 負けても同じ相手。段位は下がらない
  return setActions([{ label: 'もう一度', onClick: dojoFacing }, back]);
}

// ---------------------------------------------------------------- 決着

const VERDICT = {
  win:  { label: '勝ち', mark: '○', cls: 'win' },
  lose: { label: '負け', mark: '×', cls: 'lose' },
};

function reasonText(mine) {
  if (mine.flying) return '合図の前に抜いた';
  if (mine.noInput) return '抜けなかった';
  if (mine.result === 'lose') return 'わずかに遅かった';
  return '';
}

function onResult(m) {
  const mine = m.players.find((p) => p.id === ME) ?? m.players[0];
  const other = m.players.find((p) => p.id !== mine.id);
  const v = VERDICT[mine.result];

  const fmt = (p) => {
    if (!p) return '—';
    if (p.flying) return '早すぎ';
    if (p.noInput) return '抜かず';
    return p.R != null ? `${p.R.toFixed(0)} ms` : '—';
  };

  const notes = [reasonText(mine)];

  st.lockUntil = performance.now() + 600;
  clearStrike();
  faceTagFoe.textContent = st.peer ?? 'あいて';
  faceTagMe.textContent = st.me ?? 'あなた';
  render({
    phase: 'result', lead: `${v.mark} ${v.label}`, leadClass: v.cls,
    times: [[st.me ?? 'あなた', fmt(mine)], [st.peer ?? 'あいて', fmt(other)]],
    sub: notes.filter(Boolean).join('\n'), arena: true,
  });

  // 合図より後なので自由に動かせる。閃光 → 抜刀 → 斬撃 → 敗者が倒れる → 勝者が残心
  //
  // 刀を抜くのは間に合った側だけ。負けた側は抜く前に斬られている。
  // 引き分けが無くなったので、どちらか一方が必ず倒れる
  requestAnimationFrame(() => {
    if (mine.result === 'win') {
      el.stage.classList.add('strike');              // 斬撃は自分（左）から相手（右）へ
      el.foe.classList.add('fallen'); el.me.classList.add('zanshin', 'iai');
      sound.win();
    } else {
      el.stage.classList.add('strike', 'left');      // 相手（右）から自分（左）へ
      el.me.classList.add('fallen'); el.foe.classList.add('zanshin', 'iai');
      sound.lose();
    }
  });

  setTimeout(() => {
    if (st.phase !== 'result') return;
    dojoAfter(mine);                   // 勝てば次の段へ
  }, 600);
}

showRules();
refreshMe();
