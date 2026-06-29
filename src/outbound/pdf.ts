/**
 * Branded daily-report PDF — built directly from the {@link ClientMetrics}
 * object (NEVER from the narrative text). Milele samurai aesthetic: obsidian
 * black background, electric-lime accent, royal-violet atmospheric touches.
 * Templated and fast (vector charts, built-in fonts — no image/font I/O).
 */
import PdfPrinter from 'pdfmake';
import type { CrmClient } from '../connectors/brokeret/types.js';
import { formatCurrency, formatDuration } from '../metrics/index.js';
import type { ClientMetrics } from '../metrics/index.js';

// Derive pdfmake's document/content types from the printer (avoids relying on
// the `pdfmake/interfaces` subpath, which doesn't resolve under NodeNext).
type DocDefinition = Parameters<InstanceType<typeof PdfPrinter>['createPdfKitDocument']>[0];
type Content = DocDefinition['content'];
type Rect = { type: 'rect'; x: number; y: number; w: number; h: number; color: string };

// ── Palette ──────────────────────────────────────────────────────────────────
const OBSIDIAN = '#0B0B0F';
const PANEL = '#15151D';
const TRACK = '#22222C';
const LIME = '#AEFE02';
const VIOLET = '#8538E1';
const INK = '#ECECEF';
const MUTED = '#8A8F98';

// Built-in PDF fonts — no font files needed, so generation is instant.
const printer = new PdfPrinter({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
});

function statCard(label: string, value: string | undefined, accent: string = INK): Content {
  return {
    table: {
      widths: ['*'],
      body: [
        [{ text: label.toUpperCase(), color: MUTED, fontSize: 7, characterSpacing: 1, margin: [10, 8, 10, 0] }],
        [{ text: value ?? '—', color: accent, fontSize: 14, bold: true, margin: [10, 2, 10, 8] }],
      ],
    },
    layout: {
      fillColor: () => PANEL,
      hLineWidth: () => 0,
      vLineWidth: () => 0,
    },
    margin: [0, 0, 0, 0],
  };
}

/** Horizontal win/loss split bar (lime wins, violet losses). */
function winLossBar(metrics: ClientMetrics): Content {
  const total = metrics.wins + metrics.losses;
  const barW = 500;
  const barH = 16;
  const winW = total > 0 ? Math.round((barW * metrics.wins) / total) : 0;
  const lossW = total > 0 ? barW - winW : 0;
  const rects: Rect[] = [{ type: 'rect', x: 0, y: 0, w: barW, h: barH, color: TRACK }];
  if (winW > 0) rects.push({ type: 'rect', x: 0, y: 0, w: winW, h: barH, color: LIME });
  if (lossW > 0) rects.push({ type: 'rect', x: winW, y: 0, w: lossW, h: barH, color: VIOLET });
  return { canvas: rects, margin: [0, 4, 0, 4] };
}

/** Net P&L by symbol — one diverging bar per traded symbol. */
function pnlBySymbol(metrics: ClientMetrics): Content {
  if (metrics.mostTradedSymbols.length === 0) {
    return { text: 'No closed trades in this window.', color: MUTED, italics: true, margin: [0, 4, 0, 4] };
  }
  const maxAbs = Math.max(1, ...metrics.mostTradedSymbols.map((s) => Math.abs(s.netProfit)));
  const fullW = 300;
  const rows: Content[] = metrics.mostTradedSymbols.map((s) => {
    const w = Math.max(2, Math.round((fullW * Math.abs(s.netProfit)) / maxAbs));
    const color = s.netProfit >= 0 ? LIME : VIOLET;
    return {
      columns: [
        { width: 70, text: s.symbol, color: INK, fontSize: 9, margin: [0, 4, 0, 0] },
        {
          width: fullW + 6,
          canvas: [
            { type: 'rect', x: 0, y: 0, w: fullW, h: 12, color: TRACK },
            { type: 'rect', x: 0, y: 0, w, h: 12, color },
          ],
          margin: [0, 3, 0, 0],
        },
        { width: '*', text: formatCurrency(s.netProfit, metrics.currency), color, fontSize: 9, alignment: 'right', margin: [6, 4, 0, 0] },
      ],
      columnGap: 4,
    };
  });
  return { stack: rows };
}

function sectionTitle(text: string): Content {
  return { text: text.toUpperCase(), color: LIME, fontSize: 9, bold: true, characterSpacing: 2, margin: [0, 14, 0, 6] };
}

function buildDocDefinition(metrics: ClientMetrics, client: CrmClient): DocDefinition {
  const period = metrics.window.granularity === 'daily' ? 'Daily' : 'Weekly';
  const observations: Content =
    metrics.behavioralObservations.length > 0
      ? {
          ul: metrics.behavioralObservations.map((o) => ({ text: o, color: INK, margin: [0, 2, 0, 0] })),
          margin: [2, 0, 0, 0],
        }
      : { text: 'A quiet window — nothing notable in your activity.', color: MUTED, italics: true };

  return {
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 48],
    defaultStyle: { font: 'Helvetica', fontSize: 10, color: INK },
    background: (_page: number, size: { width: number; height: number }) => ({
      canvas: [
        { type: 'rect', x: 0, y: 0, w: size.width, h: size.height, color: OBSIDIAN },
        // Royal-violet atmospheric touch, top-right.
        { type: 'rect', x: size.width - 200, y: 0, w: 200, h: 70, color: VIOLET },
        // Electric-lime hairline under the masthead.
        { type: 'rect', x: 40, y: 96, w: size.width - 80, h: 1.5, color: LIME },
      ] as Rect[],
    }),
    content: [
      { text: 'MILELE PRIME', color: LIME, fontSize: 22, bold: true, characterSpacing: 3 },
      {
        columns: [
          { text: `${period} report`, color: MUTED, fontSize: 10, characterSpacing: 1 },
          { text: `${metrics.window.from}  →  ${metrics.window.to}`, color: MUTED, fontSize: 10, alignment: 'right' },
        ],
        margin: [0, 2, 0, 0],
      },
      { text: client.name, color: INK, fontSize: 12, bold: true, margin: [0, 14, 0, 8] },

      sectionTitle('Performance'),
      {
        columns: [
          statCard('Net P&L', metrics.display.totalPnL, metrics.totalPnL >= 0 ? LIME : VIOLET),
          statCard('Win rate', metrics.display.winRate),
          statCard('Trades', `${metrics.numTrades}`),
        ],
        columnGap: 8,
      },
      { columns: [], margin: [0, 4, 0, 0] },
      {
        columns: [
          statCard('Best', metrics.display.bestTrade, LIME),
          statCard('Worst', metrics.display.worstTrade, VIOLET),
          statCard('Avg hold', formatDuration(metrics.averageHoldMs)),
        ],
        columnGap: 8,
      },

      sectionTitle('Win / loss split'),
      winLossBar(metrics),
      {
        columns: [
          { text: `${metrics.wins} wins`, color: LIME, fontSize: 8 },
          { text: `${metrics.losses} losses`, color: VIOLET, fontSize: 8, alignment: 'right' },
        ],
      },

      sectionTitle('Net P&L by symbol'),
      pnlBySymbol(metrics),

      sectionTitle('Risk & exposure'),
      {
        columns: [
          statCard('Max drawdown', `${metrics.display.maxDrawdown} (${metrics.display.maxDrawdownPct})`, VIOLET),
          statCard('Open risk', `${metrics.display.openPositions} pos · ${metrics.display.marginUtilization}`),
          statCard('Open P&L', metrics.display.openPnL, metrics.openRisk.openPnL >= 0 ? LIME : VIOLET),
        ],
        columnGap: 8,
      },

      sectionTitle('What stood out'),
      observations,

      {
        text: 'Milele Prime AI — your own numbers, narrated. Not financial advice.',
        color: MUTED,
        fontSize: 7,
        margin: [0, 22, 0, 0],
      },
    ],
  };
}

/** Render the branded daily-report PDF for a client. */
export function buildDailyReportPdf(metrics: ClientMetrics, client: CrmClient): Promise<Buffer> {
  const doc = printer.createPdfKitDocument(buildDocDefinition(metrics, client));
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
