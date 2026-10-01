import type { Strategy, Thresholds } from './types.ts';

/** Детерминированный генератор (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Раскидать общий балл по колонкам с максимумами `maxes`.
 * Возвращает целые баллы, сумма которых равна `total` (в пределах 0..sum(maxes)).
 *
 * largest      — как в образцах: мелкие задания выполнены полностью, недобор
 *                снимается с самого «тяжёлого» подзадания, затем со следующего.
 * proportional — недобор распределяется пропорционально весу колонок.
 * random       — недобор раскидывается случайно (с сидом), тяжёлые колонки чаще.
 */
export function distribute(total: number, maxes: number[], strategy: Strategy, rng: () => number = Math.random): number[] {
  const n = maxes.length;
  if (!n) return [];
  const sum = maxes.reduce((a, b) => a + b, 0);
  const t = Math.max(0, Math.min(sum, Math.round(total)));
  const out = maxes.slice();
  let deficit = sum - t;
  if (deficit === 0) return out;

  if (strategy === 'largest') {
    // Первый проход: снижаем колонки по убыванию максимума, но не ниже 25 % от максимума.
    const order = maxes.map((_, i) => i).sort((a, b) => maxes[b] - maxes[a] || a - b);
    for (const i of order) {
      if (!deficit) break;
      const floor = Math.ceil(maxes[i] * 0.25);
      const take = Math.min(deficit, out[i] - floor);
      if (take > 0) { out[i] -= take; deficit -= take; }
    }
    for (const i of order) { // второй проход — до нуля
      if (!deficit) break;
      const take = Math.min(deficit, out[i]);
      out[i] -= take; deficit -= take;
    }
    return out;
  }

  if (strategy === 'proportional') {
    const raw = maxes.map((m) => (m / sum) * deficit);
    const cut = raw.map(Math.floor);
    let rest = deficit - cut.reduce((a, b) => a + b, 0);
    const byFrac = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || maxes[b.i] - maxes[a.i]);
    for (const { i } of byFrac) { if (!rest) break; if (cut[i] < maxes[i]) { cut[i]++; rest--; } }
    for (let i = 0; i < n; i++) out[i] -= cut[i];
    return out;
  }

  // random: по одному баллу, вероятность ∝ текущему значению колонки
  while (deficit > 0) {
    const live = out.reduce((a, b) => a + b, 0);
    if (!live) break;
    let r = rng() * live;
    for (let i = 0; i < n; i++) {
      if (r < out[i]) { out[i]--; deficit--; break; }
      r -= out[i];
    }
  }
  return out;
}

/**
 * Раскидка «по целям»: у каждой колонки целевой процент (100 — задание выполнено полностью,
 * 60 — в среднем 60 % от максимума). Баллы ученика делятся пропорционально целям, остаток
 * доводится до точной суммы, затем 1–2 случайных перестановки балла (с сидом) — чтобы строки
 * не были одинаковыми.
 */
export function distributeTargets(total: number, maxes: number[], targets: (number | undefined)[], rng: () => number = Math.random): number[] {
  const n = maxes.length;
  if (!n) return [];
  const sum = maxes.reduce((a, b) => a + b, 0);
  const t = Math.max(0, Math.min(sum, Math.round(total)));
  const want = maxes.map((m, i) => m * Math.min(100, Math.max(0, targets[i] ?? 100)) / 100);
  const wantSum = want.reduce((a, b) => a + b, 0);
  if (wantSum <= 0) return distribute(t, maxes, 'largest');
  const k = t / wantSum;
  const raw = want.map((w, i) => Math.min(maxes[i], w * k));
  const out = raw.map(Math.floor);
  let rest = t - out.reduce((a, b) => a + b, 0);
  // остаток — по убыванию дробной части, при равенстве случайно
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r), r: rng() })).sort((a, b) => b.f - a.f || a.r - b.r).map((x) => x.i);
  for (let pass = 0; rest > 0 && pass < 50; pass++) for (const i of order) { if (rest > 0 && out[i] < maxes[i]) { out[i]++; rest--; } }
  // лёгкая случайность: перенести 1 балл между двумя колонками, не выходя за пределы
  const swaps = 1 + Math.floor(rng() * 2);
  for (let s = 0; s < swaps; s++) {
    const a = Math.floor(rng() * n), b = Math.floor(rng() * n);
    if (a !== b && out[a] > 0 && out[b] < maxes[b] && out[a] > Math.floor(maxes[a] * 0.3)) { out[a]--; out[b]++; }
  }
  return out;
}

/** Оценка по доле правильных: 0.86 → 5, 0.66 → 4, 0.30 → 3, иначе 2. */
export function gradeFor(ratio: number, th: Thresholds): number {
  if (ratio >= th.five) return 5;
  if (ratio >= th.four) return 4;
  if (ratio >= th.three) return 3;
  return 2;
}
