/**
 * «Лестница баллов»: для каждого общего балла — готовая раскладка по заданиям.
 * Строится по правилу учителя (см. образцы для 5, 6 и 7 классов):
 *  1) крупные критерии снижаются по одному баллу — самый большой первым,
 *     при равных максимумах — правый раньше левого; до 5 баллов (для ≤10) или до 70 %;
 *  2) затем те же критерии опускаются до половины;
 *  3) в конце всё уходит в ноль.
 * Индекс массива = общий балл, значение = баллы по колонкам.
 */
export type Ladder = number[][];

/** Шаг правила снятия: из какой колонки снимать, по сколько за раз (0 — всё сразу), не ниже скольких. */
export interface RuleStep { col: number; step: number; floor: number }

/**
 * Лестница по правилу учителя: шаги идут по кругу — каждый снимает из своей колонки
 * `step` баллов (0 — до минимума сразу), пока колонка выше `floor`; затем следующий шаг.
 * Когда все шаги исчерпаны, остальные баллы снимаются общим правилом (generateLadder) до нуля.
 */
export function generateLadderByRule(maxes: number[], steps: RuleStep[]): Ladder {
  const max = maxes.reduce((a, b) => a + b, 0);
  const rows: Ladder = new Array(max + 1);
  const cur = maxes.slice();
  rows[max] = cur.slice();
  let total = max;
  const valid = steps.filter((s) => Number.isInteger(s.col) && s.col >= 0 && s.col < maxes.length)
    .map((s) => ({ col: s.col, step: Math.max(0, Math.round(s.step) || 0), floor: Math.min(maxes[s.col], Math.max(0, Math.round(s.floor) || 0)) }));
  let progress = true;
  while (progress && valid.length) {
    progress = false;
    for (const st of valid) {
      const room = cur[st.col] - st.floor;
      if (room <= 0) continue;
      const take = st.step > 0 ? Math.min(st.step, room) : room;
      for (let u = 0; u < take; u++) { cur[st.col]--; total--; rows[total] = cur.slice(); }
      progress = true;
    }
  }
  // остаток — общим правилом от текущего состояния
  const order = maxes.map((_, i) => i).sort((a, b) => maxes[b] - maxes[a] || b - a);
  for (const i of order) while (cur[i] > 0) { cur[i]--; total--; rows[total] = cur.slice(); }
  for (let t = 0; t <= max; t++) if (!rows[t]) rows[t] = rows[t + 1]?.slice() ?? maxes.map(() => 0);
  return rows;
}

export function generateLadder(maxes: number[]): Ladder {
  const max = maxes.reduce((a, b) => a + b, 0);
  const rows: Ladder = new Array(max + 1);
  const cur = maxes.slice();
  rows[max] = cur.slice();
  const order = maxes.map((_, i) => i).sort((a, b) => maxes[b] - maxes[a] || b - a);
  const passes: ((m: number) => number)[] = [
    (m) => (m <= 10 ? Math.min(m, 5) : Math.round(m * 0.7)),
    (m) => Math.ceil(m * 0.5),
    () => 0,
  ];
  let total = max;
  for (const floorOf of passes) {
    for (const i of order) {
      const floor = floorOf(maxes[i]);
      while (cur[i] > floor) { cur[i]--; total--; rows[total] = cur.slice(); }
    }
  }
  for (let t = 0; t <= max; t++) if (!rows[t]) rows[t] = rows[t + 1]?.slice() ?? maxes.map(() => 0);
  return rows;
}

/**
 * Достроить пропущенные строки между известными (например, с фото учителя даны только чётные баллы).
 * Строка t берётся из строки t+1: минус один балл в колонке, где верхняя известная строка ещё выше
 * нижней известной (самая правая такая колонка). Так промежуточные значения лежат «между» соседями,
 * а не строятся общим правилом вразрез с лестницей учителя. Ниже последней известной — общее правило.
 */
export function fillLadderGaps(rows: Ladder, known: Set<number>, maxes: number[]): Ladder {
  const max = maxes.reduce((a, b) => a + b, 0);
  const out = rows.map((r) => r.slice());
  const knownSorted = [...known].filter((t) => t >= 0 && t <= max).sort((a, b) => b - a);
  for (let t = max - 1; t >= 0; t--) {
    if (known.has(t)) continue;
    const lo = knownSorted.find((k) => k < t);
    if (lo == null) break; // ниже известных строк — оставляем правило
    const upper = out[t + 1];
    const lower = out[lo];
    let col = -1;
    for (let i = maxes.length - 1; i >= 0; i--) if (upper[i] > lower[i]) { col = i; break; }
    if (col < 0) for (let i = maxes.length - 1; i >= 0; i--) if (upper[i] > 0) { col = i; break; }
    if (col < 0) continue;
    const row = upper.slice();
    row[col]--;
    out[t] = row;
  }
  return out;
}

/** Строки лестницы, где сумма не совпадает с общим баллом или балл вне 0..max. */
export function ladderErrors(rows: Ladder, maxes: number[]): number[] {
  const bad: number[] = [];
  rows.forEach((r, t) => {
    if (!r) return;
    const sum = r.reduce((a, b) => a + b, 0);
    if (sum !== t || r.some((v, i) => v < 0 || v > maxes[i] || !Number.isInteger(v))) bad.push(t);
  });
  return bad;
}

/** Лестница подходит структуре (та же длина колонок и тот же максимум)? */
export function ladderFits(rows: Ladder | undefined, maxes: number[]): rows is Ladder {
  const max = maxes.reduce((a, b) => a + b, 0);
  return !!rows && rows.length === max + 1 && !!rows[max] && rows[max].length === maxes.length;
}
