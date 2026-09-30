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
