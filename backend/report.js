const PdfPrinter = require('pdfmake');
const FONTS_B64 = require('./fonts');
const GALLONS_TO_L = 3.78541;

const fonts = {
  Baskerville: {
    normal:      Buffer.from(FONTS_B64.baskerville_regular, 'base64'),
    italics:     Buffer.from(FONTS_B64.baskerville_italic,  'base64'),
    bold:        Buffer.from(FONTS_B64.baskerville_bold,    'base64'),
    bolditalics: Buffer.from(FONTS_B64.baskerville_italic,  'base64'),
  },
  Mono: {
    normal:      Buffer.from(FONTS_B64.mono_regular, 'base64'),
    bold:        Buffer.from(FONTS_B64.mono_bold,    'base64'),
    italics:     Buffer.from(FONTS_B64.mono_regular, 'base64'),
    bolditalics: Buffer.from(FONTS_B64.mono_bold,    'base64'),
  },
};
const printer = new PdfPrinter(fonts);

const C = {
  ink:      '#1A1916',
  graphite: '#3D3A34',
  drift:    '#7A7268',
  linen:    '#B8AFA3',
  stone:    '#DDD6CC',
  parch:    '#F5EFE3',
  olive:    '#6B6E4A',
  red:      '#8B2E2E',
  warn:     '#C4833A',
};

// A4: 595pt wide, margins 36 each side = 523pt usable
const PW = 523;

function gToKg(g)  { return (g > 0) ? `${(g/1000).toFixed(2)} kg` : '—'; }
function mlToL(ml) { return (ml > 0) ? `${(ml/1000).toFixed(1)} L`  : '—'; }
function effPct(v) { return v != null ? `${v}%` : '—'; }

function effColor(flag) {
  if (!flag) return C.olive;
  if (flag === 'OVER_EXPECTED') return C.red;
  if (flag === 'WASTE') return C.warn;
  return C.drift;
}
function effStatus(flag) {
  if (!flag) return 'OK';
  if (flag === 'OVER_EXPECTED') return 'Over';
  if (flag === 'WASTE') return 'Waste';
  return 'None';
}

function lbl(text, color) {
  return { text: String(text).toUpperCase(), font: 'Mono', fontSize: 7, color: color || C.drift, characterSpacing: 1.2 };
}
function mono(text, size, color) {
  return { text: String(text ?? '—'), font: 'Mono', fontSize: size || 9, color: color || C.graphite };
}
function serif(text, size, color) {
  return { text: String(text ?? '—'), font: 'Baskerville', fontSize: size || 11, color: color || C.ink };
}

// Section header — full width
function secHdr(title, pgBreak) {
  return {
    table: { widths: [PW], body: [[{ stack: [lbl(title, C.stone)], fillColor: C.graphite, margin: [10, 8, 10, 8] }]] },
    layout: 'noBorders',
    margin: [0, 16, 0, 0],
    ...(pgBreak ? { pageBreak: 'before' } : {}),
  };
}

// Efficiency pills — dynamic columns
function pills(pools) {
  const n = pools.length;
  const cellW = Math.floor(PW / n);
  const widths = Array(n-1).fill(cellW).concat([PW - cellW*(n-1)]);

  const cells = pools.map(p => {
    const e = p.eff || {};
    const noStock = !e.stocked || e.flag === 'NO_STOCK_LOGGED';
    const col = noStock ? C.linen : effColor(e.flag);
    const statusText = noStock ? 'No stock' : effStatus(e.flag);

    return {
      stack: [
        // Pool label
        lbl(p.label),
        // Big number — separate stack item so it has its own line
        { text: noStock ? '—' : `${e.efficiency_pct}%`, font: 'Baskerville', fontSize: 20, color: col, margin: [0, 8, 0, 4] },
        // Sub text
        mono(p.sub, 8, C.drift),
        // Status tag
        {
          table: {
            widths: ['auto'],
            body: [[{ stack: [lbl(statusText, col)], margin: [5, 3, 5, 3] }]]
          },
          layout: {
            hLineColor: () => col, vLineColor: () => col,
            hLineWidth: () => 0.5, vLineWidth: () => 0.5,
          },
          margin: [0, 7, 0, 0],
        },
      ],
      fillColor: C.parch,
      margin: [12, 14, 12, 14],
    };
  });

  return {
    table: { widths, body: [cells] },
    layout: {
      hLineColor: () => C.linen, vLineColor: () => C.linen,
      hLineWidth: () => 0.5, vLineWidth: () => 0.5,
    },
    margin: [0, 1, 0, 0],
  };
}

// Full-width data table
function dataTable(cols, rows) {
  // Scale columns to fill PW exactly
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  const scale = PW / totalW;
  const widths = cols.map((c, i) =>
    i < cols.length - 1 ? Math.floor(c.w * scale) : '*'
  );

  const hdr = cols.map(c => ({
    stack: [lbl(c.h)],
    fillColor: C.stone,
    margin: [7, 5, 7, 5],
  }));

  const body = rows.map((row, ri) =>
    row.map((cell, ci) => {
      const isObj = typeof cell === 'object' && cell !== null;
      const text  = isObj ? String(cell.text ?? '—') : String(cell ?? '—');
      const color = isObj ? (cell.color || C.graphite) : C.graphite;
      return {
        stack: [ci === 0
          ? serif(text, 10, color !== C.graphite ? color : C.ink)
          : mono(text, 9, color)
        ],
        fillColor: ri % 2 === 0 ? C.parch : '#F8F3E8',
        margin: [7, 5, 7, 5],
      };
    })
  );

  return {
    table: { headerRows: 1, widths, body: [hdr, ...body] },
    layout: {
      hLineColor: () => C.linen, vLineColor: () => C.linen,
      hLineWidth: () => 0.5,    vLineWidth: () => 0.5,
    },
    margin: [0, 2, 0, 0],
  };
}

function noteText(text) {
  return { text, font: 'Mono', fontSize: 8, color: C.linen, margin: [0, 6, 0, 4], lineHeight: 1.4 };
}
function emptyRow(text) {
  return { text, font: 'Mono', fontSize: 9, color: C.linen, italics: true, margin: [0, 8, 0, 0] };
}

// Status column — short enough to never wrap at any reasonable width
const EFF_COLS = [
  { h: 'Pool',        w: 95 },
  { h: 'Stock',       w: 75 },
  { h: 'Theoretical', w: 90 },
  { h: 'Remaining',   w: 75 },
  { h: 'Eff.',        w: 48 },
  { h: 'Status',      w: 70 },  // "Over", "Waste", "None", "OK" — all fit in 70pt
];

function effRow(label, e, fmt) {
  const noStock = !e || !e.stocked;
  return [
    label,
    noStock ? { text: '—', color: C.linen } : fmt(e.stocked),
    fmt(e?.used),
    e?.theoretical_remaining > 0 ? fmt(e.theoretical_remaining) : { text: '—', color: C.linen },
    { text: effPct(e?.efficiency_pct), color: effColor(e?.flag) },
    { text: effStatus(e?.flag), color: effColor(e?.flag) },
  ];
}

function generateReport({ analytics, coffeeDels, milkDels, startDate, endDate }) {
  const a   = analytics;
  const eff = a.eff || {};
  const np  = a.numilk_produced || {};
  const gen = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return printer.createPdfKitDocument({
    pageSize:    'A4',
    pageMargins: [36, 44, 36, 44],
    defaultStyle: { font: 'Mono', fontSize: 9, color: C.graphite },

    header: (page) => page === 1 ? null : {
      columns: [
        { text: 'Dose · Boxx Coffee Roasters Co.', font: 'Mono', fontSize: 7, color: C.linen, margin: [36, 14, 0, 0] },
        { text: `${startDate} to ${endDate}`, font: 'Mono', fontSize: 7, color: C.linen, alignment: 'right', margin: [0, 14, 36, 0] },
      ]
    },
    footer: (page, count) => ({
      columns: [
        { text: 'dose.up.railway.app', font: 'Mono', fontSize: 7, color: C.linen, margin: [36, 0, 0, 0] },
        { text: `Page ${page} of ${count}`, font: 'Mono', fontSize: 7, color: C.linen, alignment: 'right', margin: [0, 0, 36, 0] },
      ]
    }),

    content: [

      // ── Cover ──────────────────────────────────────────────────────────
      {
        table: { widths: [PW], body: [[{
          stack: [
            lbl('Dose · Boxx Coffee Roasters Co.', C.drift),
            { text: 'Coffee Efficiency Report', font: 'Baskerville', fontSize: 36, color: C.parch, lineHeight: 1.1, margin: [0, 14, 0, 20] },
            { canvas: [{ type: 'line', x1: 0, y1: 0, x2: PW - 48, y2: 0, lineWidth: 0.5, lineColor: C.graphite }], margin: [0, 0, 0, 14] },
            {
              columns: [
                { stack: [lbl('Period'), { text: `${startDate}  to  ${endDate}`, font: 'Mono', fontSize: 9, color: C.parch, margin: [0, 3, 0, 0] }], width: 140 },
                { stack: [lbl('Days'),         { ...serif(String(a.period?.days || '—'), 18, C.parch) }], width: 60 },
                { stack: [lbl('Total Drinks'), { ...serif((a.total_orders || 0).toLocaleString(), 18, C.parch) }], width: 90 },
                { stack: [lbl('Generated'),    mono(gen, 8, C.parch)], width: '*' },
              ],
              columnGap: 16,
            },
          ],
          fillColor: C.ink,
          margin: [24, 24, 24, 24],
        }]] },
        layout: 'noBorders',
        margin: [0, 0, 0, 0],
      },

      // ── Coffee efficiency ───────────────────────────────────────────────
      secHdr('Coffee Efficiency'),
      pills([
        { label: 'Espresso',  eff: eff.espresso,  sub: `${gToKg(eff.espresso?.used)} theoretical` },
        { label: 'Drip',      eff: eff.drip,       sub: `${gToKg(eff.drip?.used)} theoretical` },
        { label: 'Cold Brew', eff: eff.coldbrew,   sub: `${gToKg(eff.coldbrew?.used)} theoretical` },
        { label: 'Pour-Over', eff: eff.pourover,   sub: `${gToKg(eff.pourover?.used)} theoretical` },
      ]),
      noteText('Opening stock = on hand + received at first delivery. Subsequent deliveries add received only.'),
      dataTable(EFF_COLS, [
        effRow('Espresso',  eff.espresso,  gToKg),
        effRow('Drip',      eff.drip,      gToKg),
        effRow('Cold Brew', eff.coldbrew,  gToKg),
        effRow('Pour-Over', eff.pourover,  gToKg),
      ]),

      // ── Milk efficiency — page break before ────────────────────────────
      secHdr('Milk Efficiency', true),
      pills([
        { label: 'Milk',        eff: eff.milk_whole,  sub: `${mlToL(eff.milk_whole?.used)} consumed` },
        { label: 'Oat Milk',    eff: eff.milk_oat,    sub: `${mlToL(eff.milk_oat?.used)} consumed` },
        { label: 'Almond Milk', eff: eff.milk_almond, sub: `${mlToL(eff.milk_almond?.used)} consumed` },
      ]),
      noteText('Whole milk stock from gallon bottle counts. Oat & Almond from daily production rate x days.'),
      dataTable(EFF_COLS, [
        effRow('Milk',        eff.milk_whole,  mlToL),
        effRow('Oat Milk',    eff.milk_oat,    mlToL),
        effRow('Almond Milk', eff.milk_almond, mlToL),
      ]),

      // ── Numilk ─────────────────────────────────────────────────────────
      secHdr('Numilk Production vs Consumption'),
      dataTable(
        [{ h: 'Type', w: 120 }, { h: 'Rate', w: 100 }, { h: 'Days', w: 55 }, { h: 'Produced', w: 100 }, { h: 'Consumed', w: 148 }],
        [
          ['Oat Milk',    np.oat_liters_per_day    ? `${np.oat_liters_per_day} L/day`    : 'Not set', String(np.days || '—'), np.oat_ml    ? mlToL(np.oat_ml)    : '—', mlToL(a.milk_used?.oat)],
          ['Almond Milk', np.almond_liters_per_day ? `${np.almond_liters_per_day} L/day` : 'Not set', String(np.days || '—'), np.almond_ml ? mlToL(np.almond_ml) : '—', mlToL(a.milk_used?.almond)],
        ]
      ),

      // ── Modifier counts ─────────────────────────────────────────────────
      secHdr('Milk Modifier Counts from Square'),
      dataTable(
        [{ h: 'Type', w: 100 }, { h: 'Modifier Hits', w: 120 }, { h: 'ml / Modifier', w: 120 }, { h: 'Total Consumed', w: 183 }],
        [
          ['Whole',  (a.modifier_counts?.milk_whole  || 0).toLocaleString(), '180 ml', mlToL(a.milk_used?.whole)],
          ['Oat',    (a.modifier_counts?.milk_oat    || 0).toLocaleString(), '180 ml', mlToL(a.milk_used?.oat)],
          ['Almond', (a.modifier_counts?.milk_almond || 0).toLocaleString(), '180 ml', mlToL(a.milk_used?.almond)],
        ]
      ),

      // ── Coffee deliveries ───────────────────────────────────────────────
      secHdr('Coffee Deliveries in Period'),
      coffeeDels?.length > 0
        ? dataTable(
            [{ h: 'Date', w: 65 }, { h: 'Espresso', w: 70 }, { h: '+Rcvd', w: 58 }, { h: 'Drip', w: 58 }, { h: '+Rcvd', w: 58 }, { h: 'Cold Brew', w: 68 }, { h: '+Rcvd', w: 58 }, { h: 'Pour-Over', w: 88 }],
            coffeeDels.map(d => [
              d.delivery_date,
              d.espresso_lbs_onhand   > 0 ? `${d.espresso_lbs_onhand} lb`    : '—',
              d.espresso_lbs_received > 0 ? `+${d.espresso_lbs_received} lb` : '—',
              d.drip_lbs_onhand       > 0 ? `${d.drip_lbs_onhand} lb`        : '—',
              d.drip_lbs_received     > 0 ? `+${d.drip_lbs_received} lb`     : '—',
              d.coldbrew_lbs_onhand   > 0 ? `${d.coldbrew_lbs_onhand} lb`    : '—',
              d.coldbrew_lbs_received > 0 ? `+${d.coldbrew_lbs_received} lb` : '—',
              d.pourover_lbs_onhand   > 0 ? `${d.pourover_lbs_onhand} lb`    : '—',
            ])
          )
        : emptyRow('No deliveries logged in this period.'),

      // ── Milk deliveries ─────────────────────────────────────────────────
      secHdr('Milk Deliveries in Period'),
      milkDels?.length > 0
        ? dataTable(
            [{ h: 'Date', w: 80 }, { h: 'On Hand', w: 85 }, { h: 'Received', w: 85 }, { h: 'Total', w: 140 }, { h: 'Notes', w: 133 }],
            milkDels.map(d => {
              const tot = d.whole_bottles_onhand + d.whole_bottles_received;
              return [d.delivery_date, `${d.whole_bottles_onhand} gal`, `+${d.whole_bottles_received} gal`, `${tot} gal = ${(tot * GALLONS_TO_L).toFixed(1)} L`, d.notes || '—'];
            })
          )
        : emptyRow('No milk deliveries logged in this period.'),

      // ── Notes — attached so it flows with milk deliveries ───────────────
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: PW, y2: 0, lineWidth: 0.5, lineColor: C.linen }], margin: [0, 16, 0, 8] },
      noteText('5% waste threshold applied. Efficiency above 100% indicates more coffee used than theoretically expected — check recipes or grinder calibration. No stock means no delivery was recorded for this period; log deliveries in Stock to enable efficiency calculation.'),
    ],
  });
}

module.exports = { generateReport };
