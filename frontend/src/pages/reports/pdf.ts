// Se carga con import() dinámico al pulsar "Descargar PDF": jsPDF y autotable
// no deben entrar en el bundle inicial. Todo el dibujo son primitivas vectoriales.
import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'
import { formatDateNumeric, formatMonthShort, formatPeriodLabel, formatWeekdayShort, todayISO } from '../../lib/dates'
import { formatCents, formatCentsRound, formatPct } from '../../lib/money'
import type { InsightLevel, Report, ReportSeriesPoint } from '../../lib/types'
import { BUCKET_LABEL, categoryKindFor, KIND_LABEL, pctChange, reportFileName, SCOPE_LABEL } from './labels'

// Tokens de app.css (jsPDF no lee variables CSS).
const INK = '#1C2B3A'
const INK_SOFT = '#52637A'
const GRID = '#D5DEE8'
const RULE = '#E4EAF0'
const PAPER = '#F3F5F7'
const INCOME = '#157761'
const OVER = '#C62828'
const BUCKET_HEX = { needs: '#2463B5', wants: '#D08B19', savings: '#138A6B' } as const
const LEVEL: Record<InsightLevel, { color: string; word: string }> = {
  good: { color: '#157761', word: 'Bien' },
  info: { color: '#2463B5', word: 'Nota' },
  warning: { color: '#B45309', word: 'Atención' },
}

const PAGE_W = 210
const PAGE_H = 297
const M = 15
const CONTENT_W = PAGE_W - 2 * M
const BOTTOM = PAGE_H - 20 // reserva para el pie

const SUBS: [RegExp, string][] = [
  [/[   ]/g, ' '],
  [/[−–—]/g, '-'],
  [/→/g, 'a'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/…/g, '...'],
]

/** Helvetica estándar solo cubre WinAnsi: sustituye o elimina lo que quede fuera. */
function t(s: string): string {
  let out = s
  for (const [re, to] of SUBS) out = out.replace(re, to)
  // Se conserva Latin-1 y el euro (0x80 en WinAnsi).
  return out.replace(/[^ -~¡-ÿ€\n]/g, '')
}

const safeColor = (c: string | null | undefined, fallback = '#9ca3af') =>
  c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback

function niceCeil(max: number, steps = 4): { top: number; step: number } {
  if (max <= 0) return { top: steps * 100, step: 100 }
  const raw = max / steps
  const pow = 10 ** Math.floor(Math.log10(raw))
  const f = raw / pow
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
  return { top: step * steps, step }
}

function seriesLabel(kind: Report['period']['kind'], p: ReportSeriesPoint): string {
  if (kind === 'year') return formatMonthShort(p.from.slice(0, 7))
  if (kind === 'month') return String(Number(p.from.slice(8, 10)))
  return `${formatWeekdayShort(p.from)} ${Number(p.from.slice(8, 10))}`
}

export function buildReportPdf(report: Report): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const { period, scope, totals, previous } = report
  const label = formatPeriodLabel(period.kind, period.from, period.to)
  doc.setProperties({ title: t(`Informe ${label}`), creator: 'Cuentas' })

  let y = M
  const text = (s: string, x: number, yy: number, o?: Parameters<jsPDF['text']>[3]) => doc.text(t(s), x, yy, o)
  const font = (size: number, style: 'normal' | 'bold' = 'normal', color = INK) => {
    doc.setFont('helvetica', style)
    doc.setFontSize(size)
    doc.setTextColor(color)
  }
  const ensure = (h: number) => {
    if (y + h > BOTTOM) { doc.addPage(); y = M }
  }
  const section = (title: string, needed = 40) => {
    ensure(needed)
    font(12, 'bold')
    text(title, M, y + 4)
    doc.setDrawColor(GRID)
    doc.setLineWidth(0.3)
    doc.line(M, y + 6.5, M + CONTENT_W, y + 6.5)
    y += 11
  }
  const note = (s: string) => {
    font(9, 'normal', INK_SOFT)
    text(s, M, y + 3)
    y += 8
  }

  // ── Cabecera ──────────────────────────────────────────────────────────
  doc.setFillColor(BUCKET_HEX.needs); doc.roundedRect(M, y, 9, 2.4, 0.6, 0.6, 'F')
  doc.setFillColor(BUCKET_HEX.wants); doc.rect(M + 4.5, y, 3, 2.4, 'F')
  doc.setFillColor(BUCKET_HEX.savings); doc.roundedRect(M + 7.5, y, 1.5, 2.4, 0.6, 0.6, 'F')
  font(10, 'bold')
  text('Cuentas', M + 12, y + 2.2)
  font(8.5, 'normal', INK_SOFT)
  text(`Generado el ${formatDateNumeric(todayISO())}`, M + CONTENT_W, y + 2.2, { align: 'right' })
  y += 10
  font(22, 'bold')
  text(`Informe ${label}`, M, y + 6)
  y += 12
  font(10, 'normal', INK_SOFT)
  text(
    `Del ${formatDateNumeric(period.from)} al ${formatDateNumeric(period.to)}  |  Alcance: ${SCOPE_LABEL[scope]}  |  ${totals.transaction_count} movimientos`,
    M, y + 3,
  )
  y += 10

  // ── KPIs ──────────────────────────────────────────────────────────────
  const pt = previous.totals
  type Kpi = { name: string; value: string; delta: string | null; good: boolean | null; color?: string }
  const money = (cur: number, prev: number, higherIsBetter: boolean): Pick<Kpi, 'delta' | 'good'> => {
    const c = pctChange(cur, prev)
    if (c === null) return { delta: 'Sin datos previos', good: null }
    if (Math.abs(c) < 0.05) return { delta: 'Igual que antes', good: null }
    return { delta: `${c > 0 ? '+' : ''}${formatPct(c)} vs. anterior`, good: c > 0 === higherIsBetter }
  }
  let rateDelta: Pick<Kpi, 'delta' | 'good'> = { delta: 'Sin datos previos', good: null }
  if (totals.savings_rate_bp !== null && pt.savings_rate_bp !== null) {
    const d = (totals.savings_rate_bp - pt.savings_rate_bp) / 100
    rateDelta = Math.abs(d) < 0.05
      ? { delta: 'Igual que antes', good: null }
      : { delta: `${d > 0 ? '+' : ''}${d.toFixed(1).replace('.', ',')} pp vs. anterior`, good: d > 0 }
  }
  const kpis: Kpi[] = [
    { name: 'Ingresos', value: formatCents(totals.income_cents), ...money(totals.income_cents, pt.income_cents, true) },
    { name: 'Gastos', value: formatCents(totals.expense_cents), ...money(totals.expense_cents, pt.expense_cents, false) },
    {
      name: 'Neto', value: formatCents(totals.net_cents), ...money(totals.net_cents, pt.net_cents, true),
      color: totals.net_cents < 0 ? OVER : INK,
    },
    {
      name: 'Tasa de ahorro',
      value: totals.savings_rate_bp === null ? 'Sin ingresos' : formatPct(totals.savings_rate_bp / 100),
      ...rateDelta,
    },
  ]
  const gap = 3
  const kw = (CONTENT_W - gap * 3) / 4
  kpis.forEach((k, i) => {
    const x = M + i * (kw + gap)
    doc.setFillColor(PAPER); doc.setDrawColor(GRID); doc.setLineWidth(0.25)
    doc.roundedRect(x, y, kw, 22, 1.5, 1.5, 'FD')
    font(8.5, 'normal', INK_SOFT)
    text(k.name, x + 3, y + 5.5)
    font(k.value.length > 12 ? 11 : 13, 'bold', k.color ?? INK)
    text(k.value, x + 3, y + 13)
    font(7.5, 'normal', k.good === null ? INK_SOFT : k.good ? INCOME : OVER)
    text(k.delta ?? '', x + 3, y + 18.5)
  })
  y += 22 + 4
  font(8, 'normal', INK_SOFT)
  text(`Periodo anterior: ${formatPeriodLabel(previous.period.kind, previous.period.from, previous.period.to)}. Ingresos y gastos incluyen todos los movimientos, sea cual sea el alcance.`, M, y + 2)
  y += 9

  // ── Gráfico de la serie ───────────────────────────────────────────────
  const serieTitle = period.kind === 'year' ? 'Por mes' : 'Por día'
  section(`${serieTitle}: ${scope === 'expenses' ? 'gastos' : scope === 'income' ? 'ingresos' : 'ingresos y gastos'}`, 80)
  {
    const showInc = scope !== 'expenses'
    const showExp = scope !== 'income'
    const series = report.series
    const max = series.reduce((m, p) => Math.max(m, showInc ? p.income_cents : 0, showExp ? p.expense_cents : 0), 0)
    const { top, step } = niceCeil(max)
    const axisW = 15
    const h = 52
    const cx0 = M + axisW
    const cw = CONTENT_W - axisW
    const cy0 = y + 2
    const base = cy0 + h
    doc.setLineWidth(0.15)
    for (let v = 0; v <= top; v += step) {
      const yy = base - (v / top) * h
      doc.setDrawColor(v === 0 ? GRID : RULE)
      doc.line(cx0, yy, cx0 + cw, yy)
      font(7, 'normal', INK_SOFT)
      text(formatCentsRound(v), cx0 - 1.5, yy + 1, { align: 'right' })
    }
    const n = Math.max(series.length, 1)
    const slot = cw / n
    const nBars = (showInc ? 1 : 0) + (showExp ? 1 : 0)
    const barW = Math.min(slot * 0.8 / nBars, 6)
    const groupW = barW * nBars
    const labelEvery = n > 16 ? 2 : 1
    series.forEach((p, i) => {
      let x = cx0 + i * slot + (slot - groupW) / 2
      const bar = (v: number, color: string) => {
        const bh = (v / top) * h
        if (bh > 0) { doc.setFillColor(color); doc.rect(x, base - bh, barW, bh, 'F') }
        x += barW
      }
      if (showInc) bar(p.income_cents, INCOME)
      if (showExp) bar(p.expense_cents, INK)
      if (i % labelEvery === 0) {
        font(n > 16 ? 6.5 : 7.5, 'normal', INK_SOFT)
        text(seriesLabel(period.kind, p), cx0 + i * slot + slot / 2, base + 4, { align: 'center' })
      }
    })
    y = base + 9
    let lx = M + axisW
    const legend = (name: string, color: string) => {
      doc.setFillColor(color); doc.rect(lx, y - 2.2, 3, 3, 'F')
      font(8.5, 'normal', INK_SOFT)
      text(name, lx + 4.5, y + 0.4)
      lx += 4.5 + doc.getTextWidth(name) + 7
    }
    if (showInc) legend('Ingresos', INCOME)
    if (showExp) legend('Gastos', INK)
    y += 8
  }

  // ── Gráfico por categoría ─────────────────────────────────────────────
  const ckind = categoryKindFor(scope)
  const catRows = report.by_category.filter((c) => c.kind === ckind)
  section(`${ckind === 'income' ? 'Ingresos' : 'Gastos'} por categoría`, 50)
  if (catRows.length === 0) {
    note('Sin movimientos de este tipo en el periodo.')
  } else {
    const top = catRows.slice(0, 8)
    const maxAmt = top[0].amount_cents || 1
    const labelW = 48
    const valueW = 38
    const barMax = CONTENT_W - labelW - valueW - 4
    top.forEach((c) => {
      ensure(8)
      font(8.5)
      const name = t(c.name)
      const shown = doc.splitTextToSize(name, labelW - 2)[0] as string
      text(shown === name ? name : `${shown.slice(0, -1)}...`, M, y + 3.6)
      doc.setFillColor(RULE); doc.rect(M + labelW, y + 0.8, barMax, 4.2, 'F')
      doc.setFillColor(safeColor(c.color)); doc.rect(M + labelW, y + 0.8, Math.max((c.amount_cents / maxAmt) * barMax, 0.6), 4.2, 'F')
      font(8.5, 'normal', INK)
      text(`${formatCents(c.amount_cents)}  ${formatPct(c.share_bp / 100)}`, M + CONTENT_W, y + 3.8, { align: 'right' })
      y += 7
    })
    if (catRows.length > top.length) {
      font(8, 'normal', INK_SOFT)
      text(`Se muestran las ${top.length} mayores de ${catRows.length} categorías; el detalle completo está en la tabla.`, M, y + 3)
      y += 6
    }
  }
  y += 4

  // ── Tablas ────────────────────────────────────────────────────────────
  let endY = y
  const tableBase = {
    startY: 0,
    margin: { left: M, right: M, bottom: 20 },
    styles: { font: 'helvetica', fontSize: 8.5, textColor: INK, cellPadding: 2, lineColor: RULE, lineWidth: 0 },
    headStyles: { fillColor: INK, textColor: '#FFFFFF', fontStyle: 'bold' as const },
    alternateRowStyles: { fillColor: PAPER },
    showHead: 'everyPage' as const,
  }
  const runTable = (opts: Parameters<typeof autoTable>[1]) => {
    autoTable(doc, { ...tableBase, startY: y, ...opts })
    const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
    endY = last ? last.finalY : y
    y = endY + 8
  }

  section('Categorías', 30)
  if (report.by_category.length === 0) {
    note('Sin movimientos en el periodo.')
  } else {
    runTable({
      head: [['Categoría', 'Tipo', 'Cubo', 'Mov.', 'Importe', '%']],
      body: report.by_category.map((c) => [
        t(c.name), KIND_LABEL[c.kind], c.bucket ? BUCKET_LABEL[c.bucket] : '-',
        String(c.count), t(formatCents(c.amount_cents)), t(formatPct(c.share_bp / 100)),
      ]),
      columnStyles: {
        0: { cellPadding: { top: 2, bottom: 2, left: 7, right: 2 } },
        3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' },
      },
      didParseCell: (d) => {
        if (d.section === 'head' && d.column.index >= 3) d.cell.styles.halign = 'right'
      },
      didDrawCell: (d) => {
        if (d.section === 'body' && d.column.index === 0) {
          doc.setFillColor(safeColor(report.by_category[d.row.index]?.color))
          doc.circle(d.cell.x + 3.6, d.cell.y + d.cell.height / 2, 1.4, 'F')
        }
      },
    })
  }

  if (scope !== 'income') {
    section('Reparto por cubos (gasto)', 45)
    const hasTarget = report.buckets.some((b) => b.target_cents !== null)
    if (!hasTarget) note('Sin ingresos en el periodo: no hay objetivo 50/30/20 con el que comparar.')
    runTable({
      head: [['Cubo', 'Gastado', 'Objetivo', '% de los ingresos']],
      body: report.buckets.map((b) => [
        b.bucket ? BUCKET_LABEL[b.bucket] : 'Sin cubo',
        t(formatCents(b.amount_cents)),
        b.target_cents === null ? '-' : t(formatCents(b.target_cents)),
        b.income_share_bp === null ? '-' : t(formatPct(b.income_share_bp / 100)),
      ]),
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
      didParseCell: (d) => {
        if (d.section === 'head' && d.column.index >= 1) d.cell.styles.halign = 'right'
        if (d.section === 'body' && d.column.index === 1) {
          const b = report.buckets[d.row.index]
          // Solo Necesidades y Deseos se "pasan"; en Ahorro estar por encima es bueno.
          if (b && b.target_cents !== null && (b.bucket === 'needs' || b.bucket === 'wants') && b.amount_cents > b.target_cents) {
            d.cell.styles.textColor = OVER
            d.cell.styles.fontStyle = 'bold'
          }
        }
      },
    })
  }

  section('Mayores movimientos', 40)
  if (report.top_transactions.length === 0) {
    note('Sin movimientos en el periodo.')
  } else {
    runTable({
      head: [['Fecha', 'Descripción', 'Categoría', 'Importe']],
      body: report.top_transactions.map((x) => [
        formatDateNumeric(x.occurred_on),
        t(x.description ?? '-'),
        t(x.category_name ?? 'Sin categoría'),
        t(`${x.kind === 'income' ? '+' : '-'}${formatCents(x.amount_cents)}`),
      ]),
      columnStyles: {
        0: { cellWidth: 24 },
        2: { cellWidth: 44, cellPadding: { top: 2, bottom: 2, left: 7, right: 2 } },
        3: { halign: 'right', cellWidth: 30 },
      },
      didParseCell: (d) => {
        if (d.section === 'head' && d.column.index === 3) d.cell.styles.halign = 'right'
        if (d.section === 'body' && d.column.index === 3 && report.top_transactions[d.row.index]?.kind === 'income') {
          d.cell.styles.textColor = INCOME
        }
      },
      didDrawCell: (d) => {
        if (d.section === 'body' && d.column.index === 2) {
          doc.setFillColor(safeColor(report.top_transactions[d.row.index]?.category_color))
          doc.circle(d.cell.x + 3.6, d.cell.y + d.cell.height / 2, 1.4, 'F')
        }
      },
    })
  }

  // ── Análisis ──────────────────────────────────────────────────────────
  section('Análisis', 30)
  if (report.insights.length === 0) note('Sin observaciones para este periodo.')
  for (const ins of report.insights) {
    const lv = LEVEL[ins.level] ?? LEVEL.info
    font(9.5)
    const lines = doc.splitTextToSize(t(ins.message), CONTENT_W - 28) as string[]
    const h = Math.max(lines.length * 4.6, 5) + 3
    ensure(h)
    doc.setFillColor(lv.color); doc.rect(M, y, 1.2, h - 1.5, 'F')
    font(8.5, 'bold', lv.color)
    text(lv.word, M + 4, y + 3.6)
    font(9.5)
    doc.text(lines, M + 26, y + 3.6)
    y += h
  }

  // ── Pie con número de página ──────────────────────────────────────────
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setDrawColor(GRID); doc.setLineWidth(0.2)
    doc.line(M, PAGE_H - 14, M + CONTENT_W, PAGE_H - 14)
    font(8, 'normal', INK_SOFT)
    text(`Cuentas - Informe ${label} - ${SCOPE_LABEL[scope]}`, M, PAGE_H - 9.5)
    text(`Página ${i} de ${pages}`, M + CONTENT_W, PAGE_H - 9.5, { align: 'right' })
  }
  return doc
}

export function downloadReportPdf(report: Report): void {
  buildReportPdf(report).save(reportFileName(report, 'pdf'))
}
