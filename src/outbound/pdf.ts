/**
 * Branded daily/weekly performance report PDF — built directly from the
 * {@link ClientMetrics} object (NEVER from the narrative text). Milele samurai
 * aesthetic: obsidian black canvas, electric-lime accent, royal-violet
 * atmospheric touches. Templated and fast (vector charts, built-in PDF fonts —
 * no image/font I/O), so a report renders in-memory in milliseconds.
 *
 * This is the boilerplate template. Every figure is a lookup into `metrics`
 * (and the optional live `account` snapshot); once the MT5/CRM APIs are wired,
 * real per-client data flows in unchanged.
 */
import PdfPrinter from 'pdfmake';
import type { CrmClient, AccountTier } from '../connectors/brokeret/types.js';
import type { AccountSummary } from '../connectors/mt5/types.js';
import { formatCurrency, formatDuration } from '../metrics/index.js';
import type { ClientMetrics } from '../metrics/index.js';

// Derive pdfmake's document/content types from the printer (avoids relying on
// the `pdfmake/interfaces` subpath, which doesn't resolve under NodeNext).
type DocDefinition = Parameters<InstanceType<typeof PdfPrinter>['createPdfKitDocument']>[0];
type Content = DocDefinition['content'];
type Rect = { type: 'rect'; x: number; y: number; w: number; h: number; color: string; r?: number };
type Poly = { type: 'polyline'; points: { x: number; y: number }[]; color?: string; closePath?: boolean };
type Line = { type: 'line'; x1: number; y1: number; x2: number; y2: number; lineWidth: number; lineColor: string };
type CanvasEl = Rect | Poly | Line;

// ── Palette ──────────────────────────────────────────────────────────────────
const OBSIDIAN = '#0B0B0F'; // page canvas
const PANEL = '#15151D'; // stat-card fill
const PANEL_HI = '#1C1C26'; // raised / hero panel
const TRACK = '#22222C'; // bar + gauge track
const LIME = '#AEFE02'; // primary accent — gains, wins, headings
const LIME_DK = '#5F7A1E'; // dimmed lime for de-emphasis
const VIOLET = '#8538E1'; // secondary accent — losses, drawdown, risk
const INK = '#ECECEF'; // default text
const MUTED = '#8A8F98'; // labels / secondary text
const HAIRLINE = '#2A2A34';

// Content width for A4 with 40pt side margins (595.28 − 80).
const CW = 515;

// Account-tier pill colours.
const TIER_COLOR: Record<AccountTier, string> = {
  bronze: '#C77B3B',
  silver: '#B8BCC4',
  gold: '#E7B94A',
  platinum: '#8ED6E4',
};

// Built-in PDF fonts — no font files needed, so generation is instant.
const printer = new PdfPrinter({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
});

// ── Small helpers ─────────────────────────────────────────────────────────────

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Vector Milele mark: a lime shuriken diamond with a violet inner facet. */
function brandMark(size = 26): Content {
  const r = size / 2;
  const c = r;
  const outer: Poly = {
    type: 'polyline',
    closePath: true,
    color: LIME,
    points: [
      { x: c, y: 0 },
      { x: size, y: c },
      { x: c, y: size },
      { x: 0, y: c },
    ],
  };
  const inner: Poly = {
    type: 'polyline',
    closePath: true,
    color: VIOLET,
    points: [
      { x: c, y: r * 0.55 },
      { x: r * 1.45, y: c },
      { x: c, y: size - r * 0.55 },
      { x: r * 0.55, y: c },
    ],
  };
  return { canvas: [outer, inner] as CanvasEl[], width: size, margin: [0, 2, 0, 0] } as Content;
}

/** A coloured pill (small filled cell) — used for report-type and tier badges. */
function pill(text: string, bg: string, fg: string): Content {
  return {
    table: { widths: ['auto'], body: [[{ text: text.toUpperCase(), color: fg, fontSize: 7.5, bold: true, characterSpacing: 1, margin: [7, 3, 7, 3] }]] },
    layout: { fillColor: () => bg, hLineWidth: () => 0, vLineWidth: () => 0 },
  };
}

function sectionTitle(text: string): Content {
  return {
    columns: [
      { width: 'auto', text: text.toUpperCase(), color: LIME, fontSize: 9, bold: true, characterSpacing: 2, noWrap: true },
      { width: '*', canvas: [{ type: 'line', x1: 0, y1: 6, x2: CW, y2: 6, lineWidth: 0.5, lineColor: HAIRLINE }] as CanvasEl[] },
    ],
    columnGap: 10,
    margin: [0, 12, 0, 7],
  };
}

interface CardOpts {
  accent?: string | undefined;
  sub?: string | undefined;
  subColor?: string | undefined;
  big?: boolean | undefined;
  fill?: string | undefined;
}

/** A metric card: label, big value, and an optional sub-line (context/delta). */
function card(label: string, value: string | undefined, opts: CardOpts = {}): Content {
  const { accent = INK, sub, subColor = MUTED, big = false, fill = PANEL } = opts;
  const body: Content[][] = [
    [{ text: label.toUpperCase(), color: MUTED, fontSize: 7, characterSpacing: 1, margin: [11, 9, 11, 0] }],
    [{ text: value ?? '—', color: accent, fontSize: big ? 26 : 14, bold: true, margin: [11, big ? 4 : 2, 11, sub ? 0 : 9] }],
  ];
  if (sub) body.push([{ text: sub, color: subColor, fontSize: 8, margin: [11, 2, 11, 9] }]);
  return {
    table: { widths: ['*'], body },
    layout: { fillColor: () => fill, hLineWidth: () => 0, vLineWidth: () => 0 },
  };
}

/**
 * Delta vs prior window → a sub-line string + colour. The sign already lives in
 * `display` (e.g. "+$766.20", "-3.0pp"), and colour carries direction, so we
 * stay inside Helvetica's WinAnsi glyph set (no ▲/▼).
 */
function deltaSub(value: number, display: string): CardOpts {
  if (value > 0) return { sub: `${display} vs prior`, subColor: LIME };
  if (value < 0) return { sub: `${display} vs prior`, subColor: VIOLET };
  return { sub: `flat vs prior`, subColor: MUTED };
}

/** Horizontal gauge: labelled track with a proportional fill and a value tag. */
function gauge(label: string, ratio: number, valueText: string | undefined, color: string): Content {
  const w = 300;
  const fill = Math.max(2, Math.round(w * clamp01(ratio)));
  return {
    columns: [
      { width: 96, text: label, color: MUTED, fontSize: 8.5, margin: [0, 3, 0, 0] },
      {
        width: w + 6,
        canvas: [
          { type: 'rect', x: 0, y: 0, w, h: 10, color: TRACK, r: 2 },
          { type: 'rect', x: 0, y: 0, w: fill, h: 10, color, r: 2 },
        ] as CanvasEl[],
        margin: [0, 2, 0, 0],
      },
      { width: '*', text: valueText ?? '—', color, fontSize: 8.5, bold: true, alignment: 'right', margin: [6, 3, 0, 0] },
    ],
    columnGap: 6,
    margin: [0, 3, 0, 3],
  };
}

// ── Chart sections ─────────────────────────────────────────────────────────────

/** Win / loss / breakeven composition bar. */
function winLossBar(metrics: ClientMetrics): Content {
  const total = metrics.wins + metrics.losses + metrics.breakeven;
  const barW = CW;
  const barH = 16;
  const rects: Rect[] = [{ type: 'rect', x: 0, y: 0, w: barW, h: barH, color: TRACK, r: 2 }];
  if (total > 0) {
    const winW = Math.round((barW * metrics.wins) / total);
    const beW = Math.round((barW * metrics.breakeven) / total);
    const lossW = barW - winW - beW;
    let x = 0;
    if (winW > 0) rects.push({ type: 'rect', x, y: 0, w: winW, h: barH, color: LIME, r: 2 });
    x += winW;
    if (beW > 0) rects.push({ type: 'rect', x, y: 0, w: beW, h: barH, color: MUTED });
    x += beW;
    if (lossW > 0) rects.push({ type: 'rect', x, y: 0, w: lossW, h: barH, color: VIOLET, r: 2 });
  }
  return { canvas: rects as CanvasEl[], margin: [0, 2, 0, 6] };
}

/** Net P&L by symbol — one diverging bar per traded symbol, centred at zero. */
function pnlBySymbol(metrics: ClientMetrics): Content {
  if (metrics.mostTradedSymbols.length === 0) {
    return { text: 'No closed trades in this window.', color: MUTED, italics: true, margin: [0, 2, 0, 4] };
  }
  const maxAbs = Math.max(1, ...metrics.mostTradedSymbols.map((s) => Math.abs(s.netProfit)));
  const half = 150; // px each side of the zero axis
  const rows: Content[] = metrics.mostTradedSymbols.map((s) => {
    const w = Math.max(2, Math.round((half * Math.abs(s.netProfit)) / maxAbs));
    const up = s.netProfit >= 0;
    const color = up ? LIME : VIOLET;
    const barX = up ? half : half - w;
    return {
      columns: [
        { width: 66, text: s.symbol, color: INK, fontSize: 9, margin: [0, 4, 0, 0] },
        { width: 40, text: `${s.trades}×`, color: MUTED, fontSize: 8, margin: [0, 4, 0, 0] },
        {
          width: half * 2 + 6,
          canvas: [
            { type: 'rect', x: 0, y: 5, w: half * 2, h: 1, color: TRACK },
            { type: 'line', x1: half, y1: 0, x2: half, y2: 12, lineWidth: 0.5, lineColor: HAIRLINE },
            { type: 'rect', x: barX, y: 0, w, h: 12, color },
          ] as CanvasEl[],
          margin: [0, 3, 0, 0],
        },
        { width: '*', text: formatCurrency(s.netProfit, metrics.currency), color, fontSize: 9, alignment: 'right', margin: [6, 4, 0, 0] },
      ],
      columnGap: 4,
    };
  });
  return { stack: rows };
}

// ── Document ──────────────────────────────────────────────────────────────────

function profitFactor(metrics: ClientMetrics): string {
  if (metrics.grossLoss <= 0) return metrics.grossProfit > 0 ? '>99' : '—';
  return (metrics.grossProfit / metrics.grossLoss).toFixed(2);
}

function accountSnapshot(metrics: ClientMetrics, account: AccountSummary): Content {
  const cur = account.currency || metrics.currency;
  const up = account.equity >= account.balance;
  return {
    columns: [
      card('Balance', formatCurrency(account.balance, cur)),
      card('Equity', formatCurrency(account.equity, cur), { accent: up ? LIME : VIOLET }),
      card('Floating P&L', formatCurrency(account.openPnL, cur), { accent: account.openPnL >= 0 ? LIME : VIOLET }),
      card('Margin used', formatCurrency(account.margin, cur), { sub: `${metrics.display.marginUtilization} of equity` }),
    ],
    columnGap: 8,
  };
}

function buildDocDefinition(metrics: ClientMetrics, client: CrmClient, account?: AccountSummary): DocDefinition {
  const period = metrics.window.granularity === 'daily' ? 'Daily' : 'Weekly';
  const single = metrics.window.from === metrics.window.to;
  const windowLabel = single ? metrics.window.to : `${metrics.window.from}  –  ${metrics.window.to}`;
  const asOf = `${metrics.asOf.slice(0, 16).replace('T', '  ')} UTC`;

  const observations: Content =
    metrics.behavioralObservations.length > 0
      ? {
          ul: metrics.behavioralObservations.map((o) => ({ text: o, color: INK, margin: [0, 2, 0, 0] })),
          margin: [2, 0, 0, 0],
        }
      : { text: 'A quiet window — nothing notable in your activity.', color: MUTED, italics: true };

  const pnlUp = metrics.totalPnL >= 0;
  const pnlDelta: CardOpts = metrics.deltas ? deltaSub(metrics.deltas.totalPnL, metrics.deltas.display.totalPnL) : {};
  const wrDelta: CardOpts = metrics.deltas ? deltaSub(metrics.deltas.winRate, metrics.deltas.display.winRate) : {};
  const trDelta: CardOpts = metrics.deltas ? deltaSub(metrics.deltas.numTrades, metrics.deltas.display.numTrades) : {};

  return {
    pageSize: 'A4',
    pageMargins: [40, 44, 40, 54],
    defaultStyle: { font: 'Helvetica', fontSize: 10, color: INK, lineHeight: 1.15 },

    background: (_page: number, size: { width: number; height: number }) =>
      ({
        canvas: [
          { type: 'rect', x: 0, y: 0, w: size.width, h: size.height, color: OBSIDIAN },
          // Royal-violet atmospheric wash, top-right corner.
          { type: 'rect', x: size.width - 170, y: 0, w: 170, h: 6, color: VIOLET },
          // Electric-lime signature bar along the very top edge.
          { type: 'rect', x: 0, y: 0, w: size.width - 170, h: 6, color: LIME },
        ] as CanvasEl[],
      }),

    footer: (currentPage: number, pageCount: number) => ({
      margin: [40, 8, 40, 0],
      columns: [
        { width: '*', text: `Generated ${asOf}`, color: MUTED, fontSize: 7 },
        { width: 'auto', text: 'Confidential · Not financial advice', color: MUTED, fontSize: 7, alignment: 'center' },
        { width: '*', text: `${currentPage} / ${pageCount}`, color: MUTED, fontSize: 7, alignment: 'right' },
      ],
    }),

    content: [
      // ── Masthead ──────────────────────────────────────────────────────────
      {
        columns: [
          {
            width: 'auto',
            columns: [
              brandMark(26),
              {
                width: 'auto',
                stack: [
                  { text: 'MILELE PRIME', color: INK, fontSize: 18, bold: true, characterSpacing: 2 },
                  { text: 'PRIME AI · PERFORMANCE INTELLIGENCE', color: MUTED, fontSize: 6.5, characterSpacing: 1.5, margin: [0, 2, 0, 0] },
                ],
                margin: [8, 0, 0, 0],
              },
            ],
            columnGap: 0,
          },
          {
            width: '*',
            stack: [
              { columns: [{ width: '*', text: '' }, pill(`${period} report`, LIME, OBSIDIAN)], columnGap: 0 },
              { text: windowLabel, color: MUTED, fontSize: 9, alignment: 'right', margin: [0, 6, 0, 0] },
            ],
          },
        ],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 10, x2: CW, y2: 10, lineWidth: 1.2, lineColor: LIME }] as CanvasEl[] },

      // ── Prepared-for line ─────────────────────────────────────────────────
      {
        columns: [
          {
            width: '*',
            stack: [
              { text: 'PREPARED FOR', color: MUTED, fontSize: 6.5, characterSpacing: 1.5 },
              { text: client.name, color: INK, fontSize: 13, bold: true, margin: [0, 2, 0, 0] },
            ],
          },
          { width: 'auto', stack: [pill(`${client.accountTier} tier`, TIER_COLOR[client.accountTier], OBSIDIAN)], alignment: 'right' },
        ],
        margin: [0, 12, 0, 0],
      },

      // ── Account snapshot (only when the live summary is available) ─────────
      ...(account ? [sectionTitle('Account snapshot'), accountSnapshot(metrics, account)] : []),

      // ── Performance hero ──────────────────────────────────────────────────
      sectionTitle('Performance summary'),
      {
        columns: [
          {
            width: '46%',
            stack: [
              card(`Net P&L · ${period.toLowerCase()}`, metrics.display.totalPnL, {
                accent: pnlUp ? LIME : VIOLET,
                big: true,
                fill: PANEL_HI,
                ...pnlDelta,
              }),
            ],
          },
          {
            width: '*',
            stack: [
              {
                columns: [
                  card('Win rate', metrics.display.winRate, { sub: metrics.display.record, ...wrDelta }),
                  card('Profit factor', profitFactor(metrics)),
                ],
                columnGap: 8,
              },
              {
                columns: [
                  card('Trades', `${metrics.numTrades}`, trDelta),
                  card('Avg hold', formatDuration(metrics.averageHoldMs), { sub: `max ${metrics.display.longestHold ?? '—'}` }),
                ],
                columnGap: 8,
                margin: [0, 8, 0, 0],
              },
            ],
          },
        ],
        columnGap: 8,
      },

      // ── Win / loss composition ────────────────────────────────────────────
      sectionTitle('Win / loss composition'),
      winLossBar(metrics),
      {
        columns: [
          { text: `${metrics.wins} wins`, color: LIME, fontSize: 8 },
          { text: `${metrics.breakeven} breakeven`, color: MUTED, fontSize: 8, alignment: 'center' },
          { text: `${metrics.losses} losses`, color: VIOLET, fontSize: 8, alignment: 'right' },
        ],
      },
      {
        columns: [
          card('Best trade', metrics.display.bestTrade, { accent: (metrics.bestTrade?.netProfit ?? 0) >= 0 ? LIME : VIOLET }),
          card('Worst trade', metrics.display.worstTrade, { accent: (metrics.worstTrade?.netProfit ?? 0) >= 0 ? LIME : VIOLET }),
        ],
        columnGap: 8,
        margin: [0, 10, 0, 0],
      },

      // ── Net P&L by symbol ─────────────────────────────────────────────────
      sectionTitle('Net P&L by symbol'),
      pnlBySymbol(metrics),

      // ── Risk & exposure ───────────────────────────────────────────────────
      sectionTitle('Risk & exposure'),
      {
        columns: [
          card('Max drawdown', metrics.display.maxDrawdown, { accent: VIOLET, sub: metrics.display.maxDrawdownPct }),
          card('Open positions', metrics.display.openPositions, { sub: `top: ${metrics.display.topSymbol}` }),
          card('Open P&L', metrics.display.openPnL, { accent: metrics.openRisk.openPnL >= 0 ? LIME : VIOLET }),
        ],
        columnGap: 8,
      },
      { text: '', margin: [0, 6, 0, 0] },
      gauge('Margin used', metrics.openRisk.marginUtilization, metrics.display.marginUtilization, metrics.openRisk.marginUtilization > 0.5 ? VIOLET : LIME),
      gauge('Drawdown', metrics.drawdown.maxDrawdownPct, metrics.display.maxDrawdownPct, VIOLET),
      gauge('Concentration', metrics.exposureConcentration, metrics.display.exposureConcentration, metrics.exposureConcentration > 0.5 ? VIOLET : LIME_DK),

      // ── Narrative highlights ──────────────────────────────────────────────
      sectionTitle('What stood out'),
      observations,

      {
        text: 'Milele Prime AI — your own numbers, narrated. This report is generated from your MT5 account activity for information only and is not financial advice, a recommendation, or an offer. Past performance does not guarantee future results.',
        color: MUTED,
        fontSize: 7,
        italics: true,
        margin: [0, 14, 0, 0],
      },
    ],
  };
}

/** Render the branded performance-report PDF for a client. */
export function buildDailyReportPdf(
  metrics: ClientMetrics,
  client: CrmClient,
  account?: AccountSummary,
): Promise<Buffer> {
  const doc = printer.createPdfKitDocument(buildDocDefinition(metrics, client, account));
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
