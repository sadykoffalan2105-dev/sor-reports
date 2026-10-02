/** Общие типы приложения. */
import type { ReportLayout } from './layout.ts';

export type Kind = 'СОР' | 'СОЧ';

/** Колонка контрольной работы, найденная в журнале. */
export interface AssessmentColumn {
  id: string;            // уникально внутри класса
  kind: Kind;
  ordinal: number;       // порядковый номер среди колонок того же вида в журнале
  date?: string;         // «13.02»
  max: number;           // максимум баллов (обычно 50 или 40)
  col: number;           // индекс колонки в листе
  scores: (number | null)[]; // по ученикам; null — балла нет (отсутствовал)
}

export interface Student {
  n: number;
  name: string;
  id?: string;
  reason?: string;        // причина отсутствия (Б/П/Н) — форма 1/2
  retake?: string;        // дата сдачи (дд.мм.гггг)
  manualScore?: number | null; // балл, введённый вручную (для отсутствующих в журнале)
}

/** Один класс из одного файла журнала (или из ручного ввода). */
export interface JournalClass {
  id: string;
  source: string;        // имя файла
  className: string;     // «5-С»
  group?: 'мальчики' | 'девочки';
  year?: string;         // «2025–2026»
  quarter?: number;
  subject?: string;
  teacher?: string;      // полное ФИО из журнала
  students: Student[];
  assessments: AssessmentColumn[];
  selectedAssessment?: string; // id выбранной колонки
  dateHeld?: string;    // дата проведения (дд.мм.гггг), введена вручную
  dateEntered?: string; // дата внесения в emaktab
}

/** Подзадание (критерий) с максимумом баллов. */
/** Критерий; parts — подкритерии (баллы группы = их сумма). target — целевой %; bands — уровни (undefined = общие, 0 = нет). */
export interface Part { label: string; max: number; target?: number; bands?: number; parts?: Part[] }
/** Задание: либо одна колонка (parts пустой), либо несколько подколонок. */
export interface Task { title: string; parts: Part[]; max: number; target?: number; bands?: number }
export type HeaderStyle = 'full' | 'short';
/** bands — уровни по умолчанию (0/2/3/4); headerStyle — «1 задание 5 баллов» или «1 зад · 5 балл»; partNumbering — «2.1» в шапке критерия. */
export interface Structure { tasks: Task[]; bands?: number; headerStyle?: HeaderStyle; partNumbering?: boolean }

/** Сохранённая разбаловка с названием (например, «5 класс»). */
export interface Preset { id: string; name: string; structure: Structure }

export type Strategy = 'ladder' | 'targets' | 'largest' | 'proportional' | 'random';

export interface Thresholds { five: number; four: number; three: number }

export interface Settings {
  school: string;
  kind: Kind;
  number: number;         // СОР-2 → 2
  teacherShort: string;   // «Ахмедова М.М.»
  year: string;
  /** Текущая (общая) разбаловка — копия структуры выбранного пресета. */
  structure: Structure;
  /** Библиотека разбаловок и id выбранной общей. */
  presets: Preset[];
  presetId: string;
  strategy: Strategy;
  seed: number;
  /** Разброс при раскидке «по целям»: число случайных перестановок балла (0 — без случайности). */
  spread: number;
  thresholds: Thresholds;
  includeAbsent: boolean;   // строки отсутствующих в таблице
  absentColumns: boolean;   // колонки «Причина отсутствия» и «Дата сдачи»
  showDates: boolean;       // подставлять дату из журнала
  chartIncludeTotal: boolean;   // подписи общего балла над столбцами диаграммы
  fontName: string;
  /** Крупная фиолетовая цифра справа от заголовка (вариант формы). Пусто — автоматически: «1», с колонками отсутствия — «2». */
  variantLabel: string;
  /** Текст блока «Примечание» под подписью (пусто — блок не выводится). Строки разделяются \n. */
  noteText: string;
  /** Макет отчёта: блоки, шаблон заголовка, подписи колонок. */
  layout: ReportLayout;
  /** Устарело (полные лестницы); переносится в ladderRows при загрузке. */
  ladders: Record<string, number[][]>;
  /** Строки раскладки, заданные учителем: ключ — текст разбаловки, внутри — «общий балл» → баллы по колонкам. */
  ladderRows: Record<string, Record<string, number[]>>;
}

/** Колонка баллов в готовом отчёте. */
export interface ScoreColumn {
  key: string;
  taskIndex: number;
  partIndex: number;     // -1 если задание без подколонок
  path: number[];        // [задание, критерий, подкритерий…]
  header: string;        // подпись в строке 6 («5 баллов») или пусто
  max: number;
  target?: number;       // целевой % (стратегия «по целям»)
  bands: number;         // уровней под колонкой (1 — нет)
}

export interface ReportRow {
  n: number;
  name: string;
  absent: boolean;
  scores: number[];      // по ScoreColumn
  total: number;
  percent: number;
  grade: number;
  reason?: string;
  retake?: string;
  studentIndex: number;  // индекс в cls.students
}

export interface ClassReport {
  classId: string;
  sheetName: string;
  title: string;
  chartTitle: string;
  className: string;
  group?: string;
  subject: string;
  kind: Kind;
  number: number;
  date?: string;
  dateEntered?: string;
  max: number;
  columns: ScoreColumn[];
  tasks: Task[];
  structure: Structure;  // разбаловка отчёта (для шапки)
  bands: number;         // максимум уровней по колонкам (1 — нет; >1 — трёхъярусная шапка)
  headerStyle: HeaderStyle;
  rows: ReportRow[];
  participants: number;
  absent: number;
  absentNames: string[];
  avg: number[];         // средние по колонкам (участники)
  avgTotal: number;
  count5: number;
  count4: number;
  efficiency: number;    // (5+4)/участники
  teacherShort: string;
  thresholds: Thresholds;
  absentColumns: boolean;
  showDates: boolean;
  layout: ReportLayout;
}
