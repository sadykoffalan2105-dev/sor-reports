// Проверка разбора голосовых фраз: node test/voice.ts
import { parsePhrase, interpret, splitDigits, wordsToDigits, findStudent } from '../src/voice/parse.ts';

let ok = 0, bad = 0;
const eq = (name: string, got: unknown, exp: unknown) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) ok++; else { bad++; console.log(`✗ ${name}\n   ждали ${e}\n   было  ${g}`); }
};
const nums = (t: string) => parsePhrase(t).nums.map((n) => n.value);
const maxes = [5, 5, 5, 20, 10, 5];
const run = (t: string, cursor = 0, mode: 'criteria' | 'total' = 'criteria') => { const p = parsePhrase(t); return interpret(p.nums, maxes, cursor, mode, p.total); };

// числа словами и цифрами
eq('слова', nums('пять пять пять шестнадцать десять пять'), [5, 5, 5, 16, 10, 5]);
eq('цифры', nums('5 5 5 16 10 5'), [5, 5, 5, 16, 10, 5]);
eq('сорок шесть', nums('сорок шесть'), [46]);
eq('смешанно', nums('Пять, 5 и пять. Шестнадцать баллов, десять, пятёрка'), [5, 5, 5, 16, 10, 5]);
eq('узбекский', nums("besh besh besh o'n olti o'n"), [5, 5, 5, 16, 10]);
eq('узб пятнадцать', nums("o'n besh"), [15]);
eq('узб кириллица', nums('қирқ олти'), [46]);
eq('через дефис', nums('5-5-5'), [5, 5, 5]);

// разбор по критериям
eq('вся строка', run('5 5 5 16 10 5'), { kind: 'cells', start: 0, values: [5, 5, 5, 16, 10, 5] });
eq('общий балл (одно число > макс. первого)', run('46'), { kind: 'total', value: 46 });
eq('общий словом', run('общий сорок четыре'), { kind: 'total', value: 44 });
eq('режим общий', run('42', 0, 'total'), { kind: 'total', value: 42 });
eq('часть строки', run('5 5'), { kind: 'cells', start: 0, values: [5, 5] });
eq('продолжение с курсора', run('16 10 5', 3), { kind: 'cells', start: 3, values: [16, 10, 5] });
eq('слитно 555', run('555 16 10 5'), { kind: 'cells', start: 0, values: [5, 5, 5, 16, 10, 5] });
eq('слитно 1610', run('5 5 5 1610 5'), { kind: 'cells', start: 0, values: [5, 5, 5, 16, 10, 5] });
eq('больше максимума', run('5 5 9').kind, 'error');
eq('лишние числа', run('5 5 5 16 10 5 5').kind, 'error');
eq('split', splitDigits('555', [5, 5, 5]), [5, 5, 5]);
eq('split нельзя', splitDigits('99', [5, 5]), null);

// команды
eq('дальше', parsePhrase('дальше').commands, ['next']);
eq('следующий класс', parsePhrase('следующий класс').commands, ['nextClass']);
eq('отсутствует', parsePhrase('отсутствует').commands, ['absent']);
eq('нет', parsePhrase('нет').commands, ['absent']);
eq('отмена', parsePhrase('отмени').commands, ['undo']);
eq('стоп', parsePhrase('стоп').commands, ['stop']);
eq('максимум', parsePhrase('все на максимум').commands, ['full']);
eq('скачать', parsePhrase('скачай книгу').commands, ['download']);

// список под диктовку
eq('wordsToDigits', wordsToDigits('Иванов Пётр сорок шесть'), 'Иванов Пётр 46');
eq('wordsToDigits 2', wordsToDigits('Цой Артём пятнадцать'), 'Цой Артём 15');

// поиск ученика
const names = ['Алимбаев Бехруз', 'Аллаёров Алиакбар', 'Анваров Абубакр', 'Цой Артём', 'Шерматов Ислом'];
eq('фамилия точно', findStudent(['анваров'], names), 2);
eq('фамилия неточно', findStudent(['шерматова'], names), 4);
eq('начало фамилии', findStudent(['алимб'], names), 0);
eq('не ученик', findStudent(['дальше'], names), -1);
const p = parsePhrase('Цой сорок два');
eq('имя + балл', [findStudent(p.words, names), p.nums.map((n) => n.value)], [3, [42]]);

console.log(`голос: проверок ${ok + bad}, ошибок ${bad}`);
if (bad) process.exitCode = 1;
