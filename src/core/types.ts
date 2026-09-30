/** Общие типы приложения. */

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
}

/** Подзадание (критерий) с максимумом баллов. */
export interface Part { label: string; max: number }
/** Задание: либо одна колонка (parts пустой), либо несколько подколонок. */
export interface Task { title: string; parts: Part[]; max: number }
export interface Structure { tasks: Task[] }

export type Strategy = 'ladder' | 'largest' | 'proportional' | 'random';

export interface Thresholds { five: number; four: number; three: number }

export interface Settings {
  school: string;
  kind: Kind;
  number: number;         // СОР-2 → 2
  teacherShort: string;   // «Ахмедова М.М.»
  year: string;
  structure: Structure;
  strategy: Strategy;
  seed: number;
  thresholds: Thresholds;
  includeAbsent: boolean;   // строки отсутствующих в таблице
  absentColumns: boolean;   // колонки «Причина отсутствия» и «Дата сдачи»
  showDates: boolean;       // подставлять дату из журнала
  chartIncludeTotal: boolean;
  fontName: string;
  /** Отредактированные лестницы баллов, ключ — текст разбаловки («5; 5+5+20+10; 5»). */
  ladders: Record<string, number[][]>;
}

/** Колонка баллов в готовом отчёте. */
export interface ScoreColumn {
  key: string;
  taskIndex: number;
  partIndex: number;     // -1 если задание без подколонок
  header: string;        // подпись в строке 6 («5 баллов») или пусто
  max: number;
}

export interface ReportRow {
  n: number;
  name: string;
  absent: boolean;
  scores: number[];      // по ScoreColumn
  total: number;
  percent: number;
  grade: number;
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
  max: number;
  columns: ScoreColumn[];
  tasks: Task[];
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
}
