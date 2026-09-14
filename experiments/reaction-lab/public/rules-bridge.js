// 判定規則をブラウザへ渡すだけの橋。
//
// 道場（一人用モード）はサーバーに繋がずクライアントだけで1試合を進めるが、
// **判定は本物と同じものを使う。** ここで書き直すと、対人戦と道場で
// 勝ち負けの基準がずれて、稽古の意味が無くなる。
//
// game.js は classic script なので import できない。
// このモジュールが window に載せ、game.js はそれを使う。
// module は defer 相当なので game.js より後に走るが、
// 道場が始まるのはボタンを押したときなので間に合う。
import { decide, DEFAULT_CFG } from '/core/match.js';

window.__puyuriRules = { decide, DEFAULT_CFG };
