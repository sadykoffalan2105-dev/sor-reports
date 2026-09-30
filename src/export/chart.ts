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
  catRef: string;            // 'лист'!$A$7:$B$28 — двухуровневые подписи (№ + фамилия)
  catNums: string[];
  catNames: string[];
  series: ChartSeries[];
}

export interface ChartAnchor { fromCol: number; fromRow: number; toCol: number; toRow: number } // 0-based

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function txPr(size: number, bold = false): string {
  return `<c:txPr><a:bodyPr rot="0" vert="horz"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:pPr><a:endParaRPr lang="ru-RU"/></a:p></c:txPr>`;
}

/** Столбчатая диаграмма с накоплением: ученики по оси X, баллы по заданиям — сегменты столбца. */
export function chartXml(spec: ChartSpec): string {
  const n = spec.catNames.length;
  const cache = (lvl: string[]) => `<c:lvl>${lvl.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:lvl>`;
  const cat = `<c:cat><c:multiLvlStrRef><c:f>${esc(spec.catRef)}</c:f><c:multiLvlStrCache><c:ptCount val="${n}"/>${cache(spec.catNames)}${cache(spec.catNums)}</c:multiLvlStrCache></c:multiLvlStrRef></c:cat>`;
  const ser = spec.series.map((s, i) => {
    const pts = s.values.map((v, j) => (v == null ? '' : `<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>`)).join('');
    const tx = s.nameRef
      ? `<c:tx><c:strRef><c:f>${esc(s.nameRef)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
      : `<c:tx><c:v>${esc(s.name)}</c:v></c:tx>`;
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}<c:spPr><a:solidFill><a:schemeClr val="accent${(i % 6) + 1}"${i >= 6 ? '><a:lumMod val="60000"/></a:schemeClr>' : '/>'}</a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>${cat}<c:val><c:numRef><c:f>${esc(s.valRef)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${pts}</c:numCache></c:numRef></c:val></c:ser>`;
  }).join('');
  const title = `<c:title><c:tx><c:rich><a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="0"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:pPr><a:r><a:rPr lang="ru-RU"/><a:t>${esc(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:title><c:autoTitleDeleted val="0"/>`;
  const axes = `<c:catAx><c:axId val="10001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:noFill/><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln></c:spPr>${txPr(900)}<c:crossAx val="10002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="10002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900)}<c:crossAx val="10001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:date1904 val="0"/><c:lang val="ru-RU"/><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="stacked"/><c:varyColors val="0"/>${ser}<c:gapWidth val="150"/><c:overlap val="100"/><c:axId val="10001"/><c:axId val="10002"/></c:barChart>${axes}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/>${txPr(900)}</c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="ru-RU"/></a:p></c:txPr></c:chartSpace>`;
}

export function drawingXml(a: ChartAnchor, chartRel = 'rId1', id = 2): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${NS_A}"><xdr:twoCellAnchor><xdr:from><xdr:col>${a.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Диаграмма ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${chartRel}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
}

export interface ChartJob { sheetId: number; spec: ChartSpec; anchor: ChartAnchor }

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

    zip.file(`xl/drawings/drawing${k}.xml`, drawingXml(job.anchor, 'rId1', k + 1));
    zip.file(`xl/drawings/_rels/drawing${k}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${k}.xml"/></Relationships>`);
    zip.file(`xl/charts/chart${k}.xml`, chartXml(job.spec));
    ct = ct.replace('</Types>', `<Override PartName="/xl/drawings/drawing${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
  }
  zip.file('[Content_Types].xml', ct);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
