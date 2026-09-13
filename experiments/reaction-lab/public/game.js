// 刹那のぷゆり — プレイ用プロトタイプ
//
// 設計は docs/set2-5-ui.md。計測は docs/set2-4-sync-fairness.md §2 に従う。
//   t_display = t_paint + フレーム間隔（推定）
//   R = t_input − t_display
//
// UI 側が守らないと計測が壊れる点（§7）:
//   1. 合図の描画は rAF 1回で完了させる。CSS transition を挟まない
//   2. t_input は PointerEvent.timeStamp を使う
//   3. 合図待ちでは一切アニメーションしない

'use strict';

const qs = new URLSearchParams(location.search);
const params = {
  room: qs.get('room') || 'play',
  name: qs.get('name') || 'ぷゆ' + Math.random().toString(36).slice(2, 5),
};

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), face: $('face'), lead: $('lead'),
  times: $('times'), sub: $('sub'), action: $('action'), status: $('status'),
};

// ---------------------------------------------------------------- 計測

/** フレーム間隔を常時測る。合図待ち中もここだけは回るが、描画はしない */
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

/** PointerEvent.timeStamp は performance.now() と同じ time origin のはずだが、壊れていた場合に備える */
function inputTime(e, fallback) {
  const ts = e.timeStamp;
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return fallback;
  if (Math.abs(ts - fallback) > 60000) return fallback;
  return ts;
}

// ---------------------------------------------------------------- 状態

const st = {
  phase: 'connecting',
  matchId: null, roundId: null, clientId: null, peer: null,
  started: false,
  tRecv: null, tPaint: null, tDisplay: null, frameInterval: null,
  extraTaps: 0, visibilityOk: true,
  lockUntil: 0, // 結果表示直後の誤爆を防ぐ（§4.2）
};
let ws = null, eventSeq = 0;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && ['armed', 'cue'].includes(st.phase)) st.visibilityOk = false;
});

// ---------------------------------------------------------------- 画面

const RESULT = {
  win: { label: '勝ち', mark: '○', cls: 'win' },
  lose: { label: '負け', mark: '×', cls: 'lose' },
  draw: { label: '引き分け', mark: '－', cls: 'draw' },
  void: { label: 'ノーゲーム', mark: '－', cls: 'draw' },
  solo: { label: '計測のみ', mark: '－', cls: 'draw' },
};

function render({ phase, lead, sub = '', action = null, times = null, leadClass = '' }) {
  st.phase = phase;
  el.stage.className = phase === 'armed' ? 'armed' : phase === 'cue' ? 'cue' : phase === 'result' ? 'result' : '';
  el.lead.textContent = lead;
  el.lead.className = leadClass;
  el.sub.textContent = sub;
  el.times.hidden = !times;
  if (times) {
    el.times.innerHTML = times
      .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');
  }
  if (action) { el.action.hidden = false; el.action.textContent = action.label; el.action.onclick = action.onClick; }
  else { el.action.hidden = true; el.action.onclick = null; }
  renderMine();
}

const setStatus = (text, ok) => {
  el.status.innerHTML = `<span class="dot${ok ? ' on' : ''}"></span> ${text}`;
};

function showRules() {
  render({
    phase: 'rules',
    lead: '刹那のぷゆり',
    sub: '合図が出たら、すぐ押す。\n合図の前に押すと負け。',
    action: { label: 'はじめる', onClick: () => { st.started = true; showLobby(); } },
  });
}

function showLobby() {
  if (st.matchId && st.peer) {
    render({
      phase: 'matched',
      lead: `${st.peer} と対戦`,
      sub: '準備できたら押してください。',
      action: { label: '準備する', onClick: sendReady },
    });
  } else {
    render({ phase: 'waiting', lead: '相手を探しています', sub: '見つかるまで少し待ちます。' });
  }
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

function sendReady() {
  send({ type: 'READY', matchId: st.matchId });
  render({ phase: 'ready', lead: '相手の準備を待っています', sub: '' });
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
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    onMessage(m);
  };
}

function onMessage(m) {
  switch (m.type) {
    case 'WELCOME':
      st.clientId = m.clientId;
      showRules();
      break;
    case 'FULL':
      render({ phase: 'error', lead: 'この部屋は満員です', sub: '別の部屋を開いてください。' });
      break;
    case 'MATCHED':
      st.matchId = m.matchId;
      st.peer = (m.peer ?? [])[0] ?? 'あいて';
      if (m.you) st.me = m.you;
      if (st.started) showLobby();
      break;
    case 'STATE':
      if (m.matchId) st.matchId = m.matchId;
      break;
    case 'PEER_LEFT':
      st.peer = null;
      render({ phase: 'peerleft', lead: '相手が離れました', sub: '次の相手を待っています。' });
      break;
    case 'ARMED':
      onArmed(m);
      break;
    case 'GO':
      onGo(m);
      break;
    case 'RESULT':
      onResult(m);
      break;
    case 'SPING':
      send({ type: 'SPONG', seq: m.seq });
      break;
  }
}

// ---------------------------------------------------------------- 合図待ちと合図

function onArmed(m) {
  st.matchId = m.matchId ?? st.matchId;
  st.roundId = m.roundId;
  st.tRecv = st.tPaint = st.tDisplay = null;
  st.extraTaps = 0;
  st.visibilityOk = document.visibilityState === 'visible';
  // 合図待ちは完全に静止させる。カウントダウンもゲージも溜め演出も置かない（§3.2）
  render({ phase: 'armed', lead: 'まだ', sub: '' });
}

function onGo(m) {
  if (m.roundId !== st.roundId) return; // 古い合図
  st.tRecv = performance.now();
  st.phase = 'cuePending'; // 描画前の入力もフライング
  requestAnimationFrame((ts) => {
    // ここで一段に切り替える。transition を挟まないので、この rAF が t_paint になる（§3.3）
    st.tPaint = ts;
    st.frameInterval = median(frameIntervals);
    st.tDisplay = ts + st.frameInterval;
    el.stage.className = 'cue';
    el.lead.textContent = 'いま';
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
    // 合図の表示前に押した＝フライング。本人には伝えるが、相手には伝えない（§5.4）
    send({ type: 'TAP', matchId: st.matchId, roundId: st.roundId, flying: true, rtt: {} });
    render({ phase: 'sent', lead: '早すぎた', sub: '相手を待っています。' });
    return;
  }
  if (st.phase !== 'cue') { st.extraTaps++; return; } // 連打は数えるだけで送らない

  const R = tInput - st.tDisplay;
  if (R < 0) {
    send({ type: 'TAP', matchId: st.matchId, roundId: st.roundId, flying: true, rtt: {} });
    render({ phase: 'sent', lead: '早すぎた', sub: '相手を待っています。' });
    return;
  }
  send({
    type: 'TAP', matchId: st.matchId, roundId: st.roundId, flying: false, R,
    recvToPaint: st.tPaint - st.tRecv,
    inputToHandler: tHandler - tInput,
    frameInterval: st.frameInterval,
    visibilityOk: st.visibilityOk,
    extraTaps: st.extraTaps,
    rtt: {},
  });
  st.phase = 'sent';
  el.lead.textContent = `${R.toFixed(0)} ms`;
  el.sub.textContent = '相手を待っています。';
}

el.stage.addEventListener('pointerdown', (e) => {
  if (e.target === el.action) return; // ボタンはボタンとして動かす
  const tHandler = performance.now();
  handleInput(inputTime(e, tHandler), tHandler);
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  if (e.repeat) return;
  if (document.activeElement === el.action && st.phase !== 'cue' && st.phase !== 'armed') return;
  e.preventDefault();
  const tHandler = performance.now();
  handleInput(inputTime(e, tHandler), tHandler);
});

// ---------------------------------------------------------------- 結果

function reasonText(mine, other, res) {
  if (mine.flying) return '合図の前に押した';
  if (mine.tooFast) return '合図より前に反応している';
  if (mine.disconnected) return '通信が切断されました';
  if (other?.disconnected) return 'あいての通信が切断されました';
  if (mine.noInput && other?.noInput) return 'どちらも押さなかった';
  if (mine.noInput) return '押せなかった';
  if (other?.noInput) return 'あいてが押さなかった';
  if (mine.result === 'draw') return 'ほぼ同時';
  if (mine.result === 'lose') return 'わずかに遅かった';
  if (other?.flying || other?.tooFast) return 'あいてが合図の前に押した';
  return '';
}

function onResult(m) {
  const mine = m.players.find((p) => p.id === st.clientId) ?? m.players[0];
  const other = m.players.find((p) => p.id !== mine.id);
  const r = RESULT[mine.result] ?? RESULT.draw;

  const fmt = (p) => {
    if (!p) return '—';
    if (p.flying) return 'フライング';
    if (p.noInput) return '押さず';
    if (p.disconnected) return '切断';
    return p.R != null ? `${p.R.toFixed(0)} ms` : '—';
  };

  const notes = [reasonText(mine, other, m)];
  // 信用検査に関わる表示。不正とは書かない（SET2-4 §5.1）
  if (mine.Rsource === 'server-estimate') notes.push('この端末の計測値は使われませんでした');
  if (m.recorded === false) notes.push('この試合は記録されません');

  st.lockUntil = performance.now() + 600; // 合図の勢いで次に進むのを防ぐ（§4.2）
  render({
    phase: 'result',
    lead: `${r.mark} ${r.label}`,
    leadClass: r.cls,
    times: [[st.me ?? 'あなた', fmt(mine)], [st.peer ?? 'あいて', fmt(other)]],
    sub: notes.filter(Boolean).join('\n'),
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
