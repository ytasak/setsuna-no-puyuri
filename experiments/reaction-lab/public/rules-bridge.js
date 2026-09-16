// 判定規則をブラウザへ渡すだけの橋。
//
// 試合はブラウザの中で完結するが、**判定は core/match.js のものをそのまま使う。**
// ここで書き写すと、直したときに片方だけ直って食い違う。
//
// game.js は classic script なので import できない。
// このモジュールが window に載せ、game.js はそれを使う。
// module は defer 相当なので game.js より後に走るが、
// 道場が始まるのはボタンを押したときなので間に合う。
import { decide, DEFAULT_CFG } from '/core/match.js';

window.__puyuriRules = { decide, DEFAULT_CFG };
