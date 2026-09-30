import JSZip from 'jszip';

/** Экранирование текста для XML. */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ChartSeries {
  name: string;
  nameRef?: string;          // 'лист'!$C$5
  valRef: string;            // 'лист'!$C$7:$C$28
  values: (number | null)[];
}

export interface ChartSpec {
  title: string;
  /** Подписи категорий (одноуровневые, «Фамилия И.») — литеральные, не ссылки. */
  catLabels: string[];
  /** Ряды столбцов с накоплением — только колонки заданий. */
  series: ChartSeries[];
  /** Ряд «Общий балл»: невидимая линия, только подписи над столбцами. */
  totalSeries?: ChartSeries;
  /** Максимум оси значений (максимальный балл работы). */
  max: number;
}

export interface ChartAnchor { fromCol: number; fromRow: number; toCol: number; toRow: number } // 0-based

/** Фигуры, которые кладутся в тот же drawing, что и диаграмма. */
export type DrawingShape =
  | { kind: 'variant'; anchor: ChartAnchor; text: string }
  | { kind: 'note'; anchor: ChartAnchor; lines: string[] };

/** Палитра рядов (та же, что в приложении). */
export const SERIES_COLORS = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '264478', '9E480E', '636363', '997300'];

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

const GREY_TEXT = '<a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill>';
const GREY_LINE = '<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill><a:round/></a:ln>';

function txPr(size: number, bold = false, rot = 0, fill = GREY_TEXT): string {
  return `<c:txPr><a:bodyPr rot="${rot}" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}" i="0" u="none" strike="noStrike" kern="1200" baseline="0">${fill}<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:pPr><a:endParaRPr lang="ru-RU"/></a:p></c:txPr>`;
}

/** Подписи значений ряда: положение, размер, цвет текста. */
function dLbls(pos: 'ctr' | 't', size: number, bold: boolean, fill: string): string {
  return `<c:dLbls><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(size, bold, 0, fill)}<c:dLblPos val="${pos}"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;
}

function serTx(s: ChartSeries): string {
  return s.nameRef
    ? `<c:tx><c:strRef><c:f>${esc(s.nameRef)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    : `<c:tx><c:v>${esc(s.name)}</c:v></c:tx>`;
}

function serVal(s: ChartSeries, n: number): string {
  const pts = s.values.map((v, j) => (v == null ? '' : `<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>`)).join('');
  return `<c:val><c:numRef><c:f>${esc(s.valRef)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${pts}</c:numCache></c:numRef></c:val>`;
}

/** Столбчатая диаграмма с накоплением по заданиям + подписи общего балла над столбцами. */
export function chartXml(spec: ChartSpec): string {
  const n = spec.catLabels.length;
  const cat = `<c:cat><c:strLit><c:ptCount val="${n}"/>${spec.catLabels.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strLit></c:cat>`;
  const white = '<a:solidFill><a:schemeClr val="bg1"/></a:solidFill>';
  const bars = spec.series.map((s, i) => {
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${serTx(s)}<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>${dLbls('ctr', 800, false, white)}${cat}${serVal(s, n)}</c:ser>`;
  }).join('');
  const barChart = `<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/><c:varyColors val="0"/>${bars}<c:gapWidth val="60"/><c:overlap val="100"/><c:axId val="10001"/><c:axId val="10002"/></c:barChart>`;

  let lineChart = '';
  let legendEntry = '';
  if (spec.totalSeries) {
    const k = spec.series.length;
    // «Общий балл» — служебный ряд без линии и маркера: в легенде ему делать нечего
    legendEntry = `<c:legendEntry><c:idx val="${k}"/><c:delete val="1"/></c:legendEntry>`;
    const dark = '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>';
    lineChart = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/><c:ser><c:idx val="${k}"/><c:order val="${k}"/>${serTx(spec.totalSeries)}<c:spPr><a:ln><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>${dLbls('t', 900, true, dark)}${cat}${serVal(spec.totalSeries, n)}<c:smooth val="0"/></c:ser><c:marker val="1"/><c:axId val="10001"/><c:axId val="10002"/></c:lineChart>`;
  }

  const title = `<c:title><c:tx><c:rich><a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="0">${GREY_TEXT}<a:latin typeface="+mn-lt"/></a:defRPr></a:pPr><a:r><a:rPr lang="ru-RU"/><a:t>${esc(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:title><c:autoTitleDeleted val="0"/>`;
  const catAx = `<c:catAx><c:axId val="10001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:noFill/>${GREY_LINE}</c:spPr>${txPr(900, false, -2700000)}<c:crossAx val="10002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:tickLblSkip val="1"/><c:tickMarkSkip val="1"/><c:noMultiLvlLbl val="1"/></c:catAx>`;
  const max = spec.max > 0 ? `<c:max val="${spec.max}"/>` : '';
  const valAx = `<c:valAx><c:axId val="10002"/><c:scaling><c:orientation val="minMax"/>${max}<c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr>${GREY_LINE}</c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900)}<c:crossAx val="10001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/><c:majorUnit val="10"/></c:valAx>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:date1904 val="0"/><c:lang val="ru-RU"/><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${barChart}${lineChart}${catAx}${valAx}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea><c:legend><c:legendPos val="b"/>${legendEntry}<c:overlay val="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900)}</c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill>${GREY_LINE}</c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="ru-RU"/></a:p></c:txPr></c:chartSpace>`;
}

function anchorXml(a: ChartAnchor): string {
  return `<xdr:from><xdr:col>${a.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`;
}

const TNR = '<a:latin typeface="Times New Roman" panose="02020603050405020304" pitchFamily="18" charset="0"/><a:cs typeface="Times New Roman" panose="02020603050405020304" pitchFamily="18" charset="0"/>';

/** Крупная фиолетовая цифра варианта формы (как «Прямоугольник 2» в шаблоне): без заливки и линии. */
function variantShapeXml(a: ChartAnchor, text: string, id: number): string {
  const rPr = `<a:ln w="0"/><a:solidFill><a:srgbClr val="7030A0"/></a:solidFill><a:effectLst><a:outerShdw blurRad="38100" dist="19050" dir="2700000" algn="tl" rotWithShape="0"><a:schemeClr val="dk1"><a:alpha val="40000"/></a:schemeClr></a:outerShdw></a:effectLst>`;
  return `<xdr:twoCellAnchor>${anchorXml(a)}<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="Вариант ${id}"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></xdr:spPr><xdr:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="5400" b="0" cap="none" spc="0">${rPr}<a:latin typeface="Bodoni MT Black" panose="02070A03080606020203" pitchFamily="18" charset="0"/></a:rPr><a:t>${esc(text)}</a:t></a:r><a:endParaRPr lang="ru-RU" sz="5400" b="0" cap="none" spc="0">${rPr}</a:endParaRPr></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>`;
}

/**
 * Светло-зелёная заливка примечания. В шаблоне это accent6 (4EA72E) с lumMod 20 % / lumOff 80 %,
 * но тема книги ExcelJS — старая Office 2007 (accent6 = F79646, оранжевый), поэтому цвет задан явно.
 */
const NOTE_FILL = 'D9F2D0';

/** Блок «Примечание» (как «Прямоугольник 3» в шаблоне): светло-зелёная заливка, первая строка — заголовок. */
function noteShapeXml(a: ChartAnchor, lines: string[], id: number): string {
  const paras = lines.map((line, i) => {
    const sz = i === 0 ? 1600 : 1400;
    const b = i === 0 ? ' b="1"' : '';
    return `<a:p><a:r><a:rPr lang="ru-RU" sz="${sz}"${b}>${TNR}</a:rPr><a:t>${esc(line)}</a:t></a:r><a:endParaRPr lang="ru-RU" sz="${sz}"${b}>${TNR}</a:endParaRPr></a:p>`;
  }).join('');
  return `<xdr:twoCellAnchor>${anchorXml(a)}<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="Примечание ${id}"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${NOTE_FILL}"/></a:solidFill><a:ln><a:noFill/></a:ln></xdr:spPr><xdr:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>`;
}

/** drawingN.xml: диаграмма + дополнительные фигуры; у каждого cNvPr уникальный id. */
export function drawingXml(a: ChartAnchor, chartRel = 'rId1', shapes: DrawingShape[] = []): string {
  let id = 2;
  const frame = `<xdr:twoCellAnchor>${anchorXml(a)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Диаграмма ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${chartRel}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  const extra = shapes.map((sh) => {
    id++;
    return sh.kind === 'variant' ? variantShapeXml(sh.anchor, sh.text, id) : noteShapeXml(sh.anchor, sh.lines, id);
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${extra}${frame}</xdr:wsDr>`;
}

export interface ChartJob { sheetId: number; spec: ChartSpec; anchor: ChartAnchor; shapes: DrawingShape[] }

/** Дописать диаграммы в готовый xlsx (ExcelJS их не умеет): drawing + chart + связи + типы содержимого. */
export async function injectCharts(xlsx: ArrayBuffer | Uint8Array, jobs: ChartJob[]): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(xlsx);
  let ct = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
  let k = 0;
  for (const job of jobs) {
    k++;
    const sheetPath = `xl/worksheets/sheet${job.sheetId}.xml`;
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) continue;
    let sheet = await sheetFile.async('string');
    const relsPath = `xl/worksheets/_rels/sheet${job.sheetId}.xml.rels`;
    let rels = (await zip.file(relsPath)?.async('string')) ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const relId = `rIdChart${k}`;
    rels = rels.replace('</Relationships>', `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${k}.xml"/></Relationships>`);
    zip.file(relsPath, rels);

    const tag = `<drawing r:id="${relId}"/>`;
    const m = sheet.match(/<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
    sheet = m && m.index != null ? sheet.slice(0, m.index) + tag + sheet.slice(m.index) : sheet.replace('</worksheet>', `${tag}</worksheet>`);
    if (!/xmlns:r=/.test(sheet.slice(0, 600))) sheet = sheet.replace('<worksheet ', `<worksheet xmlns:r="${NS_R}" `);
    zip.file(sheetPath, sheet);

    zip.file(`xl/drawings/drawing${k}.xml`, drawingXml(job.anchor, 'rId1', job.shapes));
    zip.file(`xl/drawings/_rels/drawing${k}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${k}.xml"/></Relationships>`);
    zip.file(`xl/charts/chart${k}.xml`, chartXml(job.spec));
    ct = ct.replace('</Types>', `<Override PartName="/xl/drawings/drawing${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
  }
  zip.file('[Content_Types].xml', ct);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
