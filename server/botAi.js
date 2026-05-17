// Bot AI: 手札とゲーム状態から次の手を決定する
// 戻り値: { action: 'play', cardId, choice } | { action: 'draw' }

// ─── スキルレベル定義 ─────────────────────────────────────────────
//   beginner:    初心者向け。半分くらいランダム手、ほぼ読まない、温存もしない
//   intermediate: 標準。バーストはできるだけ避け、相手読みも少し
//   expert:      しっかり読む、温存も上手い、相手を 95-100 に追い込もうとする
const SKILL_LEVELS = {
  beginner: {
    label: '🟢 初級',
    randomActionRate: 0.4,    // 40% でランダム手
    lookaheadWeight: 0.2,     // 相手読みの重み 20%
    preservationWeight: 0.3,  // 温存の重み 30%
    aggressionBonus: 0,
    randomNoise: 1.5,         // スコアに大きめのランダム加算
  },
  intermediate: {
    label: '🟡 中級',
    randomActionRate: 0.05,
    lookaheadWeight: 1.0,
    preservationWeight: 1.0,
    aggressionBonus: 2,
    randomNoise: 0.5,
  },
  expert: {
    label: '🔴 上級',
    randomActionRate: 0.0,
    lookaheadWeight: 1.5,     // 相手読みを強化
    preservationWeight: 1.2,
    aggressionBonus: 3,       // 追い込みボーナス (5 から 3 に緩和。自滅頻度を下げる)
    randomNoise: 0.1,
  },
};

const SKILL_KEYS = Object.keys(SKILL_LEVELS);
function getSkill(key) {
  return SKILL_LEVELS[key] || SKILL_LEVELS.intermediate;
}

// ─── カード値計算 ────────────────────────────────────────────────
function cardValue(rank, currentTotal, choice) {
  if (rank === 'A') return 1;
  if (rank === 'Joker') return currentTotal === 100 ? 1 : 50;
  if (rank === 'J') return 10;
  if (rank === 'Q') return 20;
  if (rank === 'K') return 30;
  if (rank === '10') return choice === 'plus' ? 10 : -10;
  if (rank === '8') return choice === 'plus' ? 8 : 0;
  if (rank === '9') return choice === 'plus' ? 9 : 0;
  return parseInt(rank, 10);
}

// カード+選択肢ごとの候補を列挙
function enumerateChoices(card) {
  if (card.rank === '10') return [{ choice: 'plus' }, { choice: 'minus' }];
  if (card.rank === '8')  return [{ choice: 'plus' }, { choice: 'skip' }];
  if (card.rank === '9')  return [{ choice: 'plus' }, { choice: 'return' }];
  return [{ choice: null }];
}

// 1候補のスコア (高いほど良い)
function scoreOption(card, currentTotal, choice, randomNoise) {
  const val = cardValue(card.rank, currentTotal, choice);
  const newTotal = Math.max(0, currentTotal + val);

  if (card.rank === 'Joker' && currentTotal === 100) return 1200;
  if (newTotal === 101) return 1000;
  if (newTotal > 101)   return -1000 - (newTotal - 101);

  let score = 0;
  if (newTotal === 100) score -= 30;
  else if (newTotal >= 95) score -= 10;
  else if (newTotal <= 50) score += 5;

  score -= Math.abs(val) * 0.1;
  return score + Math.random() * randomNoise;
}

// 相手が次にバーストしやすいかを評価
function opponentDifficultyScore(newTotal) {
  if (newTotal >= 95 && newTotal < 101) {
    const dist = 101 - newTotal;
    if (dist <= 1) return 15;
    if (dist <= 3) return 10;
    if (dist <= 5) return 6;
    return 3;
  }
  return 0;
}

function handPreservationBonus(card) {
  if (card.rank === '10') return -3;
  if (card.rank === '8' || card.rank === '9') return -1.5;
  if (card.rank === 'Joker') return -5;
  return 0;
}

// ─── 初級用: ランダム手 ─────────────────────────────────────────
//   ただし「100% バースト確実」だけは避ける (運も実力 + 救済)
function beginnerRandomAction(hand, currentTotal) {
  if (!hand || hand.length === 0) return { action: 'draw' };
  // 全候補を列挙してバーストするものを除外
  const safe = [];
  for (const card of hand) {
    for (const { choice } of enumerateChoices(card)) {
      const val = cardValue(card.rank, currentTotal, choice);
      const newTotal = Math.max(0, currentTotal + val);
      // バーストする選択肢は除外。それ以外はランダム
      if (newTotal <= 101) safe.push({ card, choice });
    }
  }
  // 全部バーストしかない場合は山札から引く (運に賭ける)
  if (safe.length === 0) return { action: 'draw' };
  const pick = safe[Math.floor(Math.random() * safe.length)];
  return { action: 'play', cardId: pick.card.id, choice: pick.choice };
}

// ─── メインの判断関数 (skill パラメタ追加) ───────────────────
function decideBotMove(hand, currentTotal, playerCount, skillKey) {
  if (!hand || hand.length === 0) return { action: 'draw' };

  const skill = getSkill(skillKey);

  // 初級: 一定確率でランダム手 (運要素を入れて初心者を勝たせる)
  if (skill.randomActionRate > 0 && Math.random() < skill.randomActionRate) {
    return beginnerRandomAction(hand, currentTotal);
  }

  // 手札に減算/スキップ/リターン系のセーフカードがあるか。
  // 無い時は攻撃を弱める (合計を高く保つと自分のターンで bust 確定するため)。
  const hasSafetyCard = hand.some(
    (c) => c.rank === '10' || c.rank === '8' || c.rank === '9' || c.rank === 'Joker'
  );
  const effectiveAggression = hasSafetyCard
    ? skill.aggressionBonus
    : skill.aggressionBonus * 0.3;

  let best = null;
  for (const card of hand) {
    for (const { choice } of enumerateChoices(card)) {
      let s = scoreOption(card, currentTotal, choice, skill.randomNoise);

      const val = cardValue(card.rank, currentTotal, choice);
      const newTotal = Math.max(0, currentTotal + val);

      // 相手読み (lookahead) — スキルに応じて重み付け
      if (newTotal < 101) {
        s += opponentDifficultyScore(newTotal) * skill.lookaheadWeight;
      }

      // 手札温存 (3 枚以上のとき) — スキルに応じて重み付け
      if (hand.length >= 3) {
        s += handPreservationBonus(card) * skill.preservationWeight;
      }

      // 1 対 1 アグレッション + スキル別ボーナス
      // セーフカードが手元に無い時は effectiveAggression が下がり、合計を 90+ まで押し上げる動機を弱める
      if (playerCount && playerCount <= 2 && newTotal >= 90 && newTotal < 101) {
        s += effectiveAggression;
      }

      if (!best || s > best.score) {
        best = { score: s, cardId: card.id, choice, rank: card.rank };
      }
    }
  }

  if (best.score <= -1000) return { action: 'draw' };
  return { action: 'play', cardId: best.cardId, choice: best.choice };
}

// 引いたカードの扱い: 選択が必要なときのみ
function decideDrawnCardChoice(card, currentTotal, skillKey) {
  const skill = getSkill(skillKey);
  let best = null;
  for (const { choice } of enumerateChoices(card)) {
    const s = scoreOption(card, currentTotal, choice, skill.randomNoise);
    if (!best || s > best.score) best = { score: s, choice };
  }
  return best ? best.choice : 'plus';
}

module.exports = { decideBotMove, decideDrawnCardChoice, SKILL_LEVELS, SKILL_KEYS };
