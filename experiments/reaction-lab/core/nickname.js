// その日限りの二つ名。
//
// 名前を入力させると kusa の「匿名で遊べる」から外れるし、入力の手間で離脱する。
// かといってランキングが「ぷゆ」だらけでは区別がつかない。
// そこでサーバーが (token, ゲーム日) から決まる名前を自動で振る。
// 翌日には別の名前になるので、名前で人を追跡できない。
//
// docs/set2-6-stats-ranking.md §4

const PREFIX_SRC = [
  '夜半', '三日月', '一閃', '霜降り', '朝靄', '遠雷', '刹那', '影踏み',
  '星待ち', '風待ち', '薄氷', '野分', '陽炎', '宵闇', '暁', '黄昏',
  '柳生', '無明', '不知火', '雷光', '疾風', '静寂', '木枯らし', '山颪',
  '白露', '寒月', '空蝉', '朧', '残心', '居合', '抜き身', '紙一重',
  '目にも留まらぬ', '間合い', '半歩', '瞬き', '息継ぎ', '爪先', '指先', '手元',
];
const NA = [
  'ぷゆ', 'ぷゆ丸', 'ぷゆ助', 'ぷゆ斎', 'ぷゆ坊', 'ぷゆ太', 'ぷゆ次郎', 'ぷゆ蔵',
  'ぷゆ衛門', 'ぷゆ之進', 'ぷゆ兵衛', 'ぷゆ庵', 'ぷゆ道', 'ぷゆ心', 'ぷゆ眼', 'ぷゆ剣',
];

const PREFIX = PREFIX_SRC;

/** FNV-1a。暗号用途ではない。同じ入力から同じ名前を得るためだけに使う */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** (token, ゲーム日) から決まる二つ名。同じ日は同じ名前になる */
export function nickname(token, date) {
  const h = hash(`${token}:${date}`);
  return `${PREFIX[h % PREFIX.length]}の${NA[(h >>> 8) % NA.length]}`;
}

export const nicknameSpace = PREFIX.length * NA.length;
