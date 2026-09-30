// Проверка модуля распознавания разбаловки: node test/vision.ts
// С ANTHROPIC_API_KEY — живой вызов на samples/ladder-photo-1.webp; без ключа — только нормализация.
import { readFileSync } from 'node:fs';
import { normalizeResponse, recognizeImageData, type LadderPhotoResponse } from '../src/vision/recognize.ts';

let fails = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) fails++;
}

// Смоделированный ответ модели по фото ladder-photo-1: у 7 класса подписи 44/42/40 при суммах 46/44/42
const mock: LadderPhotoResponse = {
  classes: [
    {
      label: '5 класс',
      tasks: [{ title: '1зд', parts: [5] }, { title: '2зд', parts: [5, 5, 20, 10] }, { title: '3зд', parts: [5] }],
      rows: [
        { written_total: 50, scores: [5, 5, 5, 20, 10, 5] },
        { written_total: 48, scores: [5, 5, 5, 18, 10, 5] },
        { written_total: 46, scores: [5, 5, 5, 16, 10, 5] },
        { written_total: 44, scores: [5, 5, 5, 14, 10, 5] },
        { written_total: 42, scores: [5, 5, 5, 14, 8, 5] },
        { written_total: 40, scores: [5, 5, 5, 14, 6, 5] },
      ],
      notes: [],
    },
    {
      label: '7 класс',
      tasks: [{ title: null, parts: [5] }, { title: null, parts: [2, 3, 7, 7, 7, 9, 5] }, { title: null, parts: [5] }],
      rows: [
        { written_total: 50, scores: [5, 2, 3, 7, 7, 7, 9, 5, 5] },
        { written_total: 48, scores: [5, 2, 3, 7, 7, 7, 7, 5, 5] },
        { written_total: 44, scores: [5, 2, 3, 7, 7, 7, 5, 5, 5] },
        { written_total: 42, scores: [5, 2, 3, 7, 7, 5, 5, 5, 5] },
        { written_total: 40, scores: [5, 2, 3, 7, 5, 5, 5, 5, 5] },
        { written_total: 38, scores: [5, 2, 3, 7, 5, 5, 5] }, // мало чисел — должна быть отброшена
      ],
      notes: ['цифра в 3-й строке читается неуверенно'],
    },
    { label: 'пустой', tasks: [], rows: [], notes: [] },
  ],
};

console.log('нормализация смоделированного ответа:');
const r = normalizeResponse(mock);
check(r.classes.length === 2, `блоков с разбаловкой: ${r.classes.length} (ожидалось 2)`);
check(r.warnings.some((w) => w.includes('пустой')), 'пустой блок отмечен предупреждением');

const c5 = r.classes[0];
check(c5.structureText === '5; 5+5+20+10; 5', `5 класс: разбаловка «${c5.structureText}»`);
check(c5.titles.join('|') === '1зд|2зд|3зд', `5 класс: названия ${c5.titles.join('|')}`);
check(c5.ladder.map((x) => x.total).join() === '50,48,46,44,42,40', `5 класс: суммы ${c5.ladder.map((x) => x.total).join(' ')}`);
check(c5.warnings.length === 0, `5 класс: предупреждений ${c5.warnings.length} (ожидалось 0)`);

const c7 = r.classes[1];
check(c7.structureText === '5; 2+3+7+7+7+9+5; 5', `7 класс: разбаловка «${c7.structureText}»`);
check(c7.ladder.map((x) => x.total).join() === '50,48,46,44,42', `7 класс: суммы ${c7.ladder.map((x) => x.total).join(' ')} (по фактическим суммам)`);
check(c7.warnings.some((w) => w.includes('подписана 44') && w.includes('сумма 46')), 'есть предупреждение «подписана 44, сумма 46»');
check(c7.warnings.some((w) => w.includes('подписана 42') && w.includes('сумма 44')), 'есть предупреждение «подписана 42, сумма 44»');
check(c7.warnings.some((w) => w.includes('подписана 40') && w.includes('сумма 42')), 'есть предупреждение «подписана 40, сумма 42»');
check(c7.warnings.some((w) => w.includes('7 чисел вместо 9')), 'короткая строка отброшена с предупреждением');
check(c7.warnings.some((w) => w.startsWith('замечание модели')), 'замечание модели перенесено в warnings');
check(c7.titles.every((t) => t === ''), '7 класс: названия пустые (null → «»)');

const bad = normalizeResponse({
  classes: [{ label: '6', tasks: [{ title: null, parts: [5, 5] }], rows: [{ written_total: 8, scores: [4, 4] }], notes: [] }],
});
check(bad.classes[0].warnings.some((w) => w.includes('не совпадает с максимумами')), 'первая строка ≠ максимумам → предупреждение');
for (const c of r.classes) for (const w of c.warnings) console.log(`    [${c.label}] ${w}`);
for (const w of r.warnings) console.log(`    [общее] ${w}`);

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log('ANTHROPIC_API_KEY: ключ не задан, пропуск живого вызова');
} else {
  const file = process.argv[2] ?? 'samples/ladder-photo-1.webp';
  console.log(`живой вызов: ${file}`);
  const data = readFileSync(file).toString('base64');
  const media_type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  const live = await recognizeImageData({ data, media_type }, { apiKey: key });
  console.log(JSON.stringify(live, null, 2));
}

console.log(fails ? `ОШИБОК: ${fails}` : 'нормализация: все проверки пройдены');
process.exitCode = fails ? 1 : 0;
