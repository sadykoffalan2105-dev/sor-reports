/** Макет отчёта: какие блоки выводить, шаблоны заголовков, подписи колонок. */
export interface ReportLayout {
  titleTemplate: string;
  chartTitleTemplate: string;
  showTitle: boolean;      // заголовок (строка 1)
  showInfo: boolean;       // «Участвовали / Отсутствовали» и даты
  showVariant: boolean;    // фиолетовая цифра варианта
  showAvg: boolean;        // «Сред.балл»
  showPct: boolean;        // «Процентный показатель»
  showCounts: boolean;     // «Количество 5 / 4»
  showEff: boolean;        // «Эффективность знаний»
  showSignature: boolean;
  showNote: boolean;
  showChart: boolean;
  labels: { name: string; total: string; percent: string; grade: string; signature: string };
}

export const DEFAULT_LAYOUT: ReportLayout = {
  titleTemplate: '{школа} ОТЧЁТНЫЕ РЕЗУЛЬТАТЫ проверки заданий {вид}-{номер} по предмету «{предмет}»  {группа} учащихся {класс} класса за {год} учебный год',
  chartTitleTemplate: '{вид}-{номер} по предмету «{предмет}»  {группа} учащихся {класс} класса',
  showTitle: true, showInfo: true, showVariant: true,
  showAvg: true, showPct: true, showCounts: true, showEff: true,
  showSignature: true, showNote: true, showChart: true,
  labels: { name: 'Фамилия имя ученика', total: 'Общий балл', percent: 'В%', grade: 'Оценивание', signature: 'Фамилия учителя-предметника:' },
};

/** Готовые макеты. */
export const LAYOUT_PRESETS: { name: string; patch: Partial<ReportLayout> }[] = [
  { name: 'Школа № 300 — полный', patch: {} },
  { name: 'Только таблица', patch: { showTitle: false, showInfo: false, showVariant: false, showAvg: false, showPct: false, showCounts: false, showEff: false, showSignature: false, showNote: false, showChart: false } },
  { name: 'Таблица и итоги, без диаграммы', patch: { showVariant: false, showNote: false, showChart: false } },
  { name: 'Форма с уровнями (2026)', patch: { titleTemplate: '{школа}\nОТЧЁТНЫЙ РЕЗУЛЬТАТЫ\nпроверка знаний {вид}-{номер}({макс}) по предмету {предмет} “{группа}”\n{класс} класса за {год} учебный год', chartTitleTemplate: '{вид}-{номер} по предмету {предмет}, {класс} класс', showVariant: false, showNote: false, labels: { name: 'Фамилия имя ученика', total: 'общий балл', percent: 'В%', grade: 'Оценка', signature: 'Учитель:' } } },
  { name: 'Короткая шапка', patch: { titleTemplate: '{вид}-{номер} по предмету «{предмет}», {класс} класс ({группа}), {год} учебный год', showVariant: false, showNote: false } },
];

export type TemplateVars = Record<string, string>;

/** Подстановка {школа}, {вид}, {номер}, {предмет}, {группа}, {класс}, {год}; лишние пробелы схлопываются. */
export function fillTemplate(tpl: string, vars: TemplateVars): string {
  return tpl.replace(/\{([^}]+)\}/g, (_, k: string) => vars[k.trim().toLowerCase()] ?? '').replace(/[ \t]{2,}/g, '  ').replace(/\s+([,.)])/g, '$1').trim();
}

export function mergeLayout(base: ReportLayout, patch: Partial<ReportLayout> | undefined): ReportLayout {
  return { ...base, ...(patch ?? {}), labels: { ...base.labels, ...(patch?.labels ?? {}) } };
}
