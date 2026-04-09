/**
 * Imports the GPS Website pricing workbook into config.json.
 *
 *   node import-xlsx.js "6 Items Price Calculator GPS Website Item Price Data Apr 7, 2026.xlsx"
 *
 * Each sheet has its own parser because the layouts vary.
 * Output is a normalized config consumed by engine.js (lookup mode) and
 * engine-coroplast.js. Add-ons (turnaround, grommets, h-stand, double-sided)
 * are stored once at the top level and apply to any product that opts in.
 */

const fs   = require('fs')
const path = require('path')
const XLSX = require('xlsx')

const SRC = process.argv[2] || '6 Items Price Calculator GPS Website Item Price Data Apr 7, 2026.xlsx'
const OUT = path.join(__dirname, 'config.json')

const wb = XLSX.readFile(path.resolve(SRC))
const sheet = name => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' })

const trim = v => (typeof v === 'string' ? v.trim() : v)
const isNum = v => typeof v === 'number' && !isNaN(v)

// ── Brochure ─────────────────────────────────────────────────────────────────
// Header: Product Name | Size | Paper Stock | Folding | Qty | Base Price | ...
// One block per size. Turnaround columns ignored — handled globally.
function parseBrochure() {
  const rows = sheet('Brochure')
  const table = []
  const sizes = new Set(), stocks = new Set(), folds = new Set(), qtys = new Set()

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] !== 'Product Name') continue
    let size = null, stock = null, fold = null, prices = {}
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[j]
      if (r[0] === 'Product Name') break
      if (!isNum(r[4])) continue
      if (trim(r[1])) size  = trim(r[1])
      if (trim(r[2])) stock = trim(r[2])
      if (trim(r[3])) fold  = trim(r[3])
      const qty = r[4], base = r[5]
      if (!isNum(base)) continue
      prices[qty] = round4(base)
      sizes.add(size); stocks.add(stock); folds.add(fold); qtys.add(qty)
    }
    if (size && Object.keys(prices).length) {
      table.push({ key: { size, paper_stock: stock, folding: fold }, prices })
    }
  }

  return {
    label: 'Brochure',
    mode: 'lookup',
    lookup_keys: ['size', 'paper_stock', 'folding'],
    options: {
      size:        [...sizes],
      paper_stock: [...stocks],
      folding:     [...folds],
    },
    quantities: [...qtys].sort((a, b) => a - b),
    price_table: table,
  }
}

// ── Flyer ────────────────────────────────────────────────────────────────────
// Mixed block layouts. Some blocks have separate Single/Double tables; others
// combine them. We capture (size, sides) → unit price.
function parseFlyer() {
  const rows = sheet('Flyer')
  const table = []
  const sizes = new Set(), stocks = new Set(), qtys = new Set()
  const PRICE_COL = { single: 5, double: 5 }

  for (let i = 0; i < rows.length; i++) {
    const h = rows[i]
    if (h[1] !== 'Product Name') continue
    // Detect which columns hold single/double prices
    const colSingle = h.findIndex(c => /Single Sided|Base Price$|^Base Price\b/.test(String(c)) && !/Double/.test(String(c)))
    const colDouble = h.findIndex(c => /Double Side|Double sided|Double Sided/.test(String(c)))

    let size = null, stock = null
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[j]
      if (r[1] === 'Product Name') break
      if (!isNum(r[4])) continue
      if (trim(r[2])) size  = trim(r[2])
      if (trim(r[3])) stock = trim(r[3])
      const qty = r[4]
      qtys.add(qty); sizes.add(size); stocks.add(stock)
      if (colSingle > 0 && isNum(r[colSingle])) addPrice(table, { size, paper_stock: stock, sides: 'single' }, qty, r[colSingle])
      if (colDouble > 0 && isNum(r[colDouble])) addPrice(table, { size, paper_stock: stock, sides: 'double' }, qty, r[colDouble])
    }
  }

  return {
    label: 'Flyer',
    mode: 'lookup',
    lookup_keys: ['size', 'paper_stock', 'sides'],
    options: {
      size:        [...sizes],
      paper_stock: [...stocks],
      sides:       ['single', 'double'],
    },
    quantities: [...qtys].sort((a, b) => a - b),
    price_table: table,
    allowed_addons: ['grommet', 'h_stand'],
  }
}

// ── Business Card ────────────────────────────────────────────────────────────
// Each block: Size · Paper Stock · Qty · then 8 price columns (variant × sameday).
// We import the 4 base variants (sameday columns ignored — turnaround is global).
function parseBusinessCard() {
  const rows = sheet('Business card')
  const table = []
  const sizes = new Set(), stocks = new Set(), qtys = new Set()
  const VARIANTS = {
    base:               4,
    double_sided:       6,
    round_corner:       8,
    ds_round_corner:   10,
  }

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] !== 'Product Name') continue
    let size = null, stock = null
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[j]
      if (r[0] === 'Product Name') break
      if (!isNum(r[3])) continue
      if (trim(r[1])) size  = trim(r[1])
      if (trim(r[2])) stock = trim(r[2])
      const qty = r[3]
      qtys.add(qty); sizes.add(size); stocks.add(stock)
      for (const [variant, col] of Object.entries(VARIANTS)) {
        if (isNum(r[col])) addPrice(table, { size, paper_stock: stock, variant }, qty, r[col])
      }
    }
  }

  return {
    label: 'Business Card',
    mode: 'lookup',
    lookup_keys: ['size', 'paper_stock', 'variant'],
    options: {
      size:        [...sizes],
      paper_stock: [...stocks],
      variant: [
        { key: 'base',             label: 'Single-Sided, Square Corner' },
        { key: 'double_sided',     label: 'Double-Sided, Square Corner' },
        { key: 'round_corner',     label: 'Single-Sided, Round Corner' },
        { key: 'ds_round_corner',  label: 'Double-Sided, Round Corner' },
      ],
    },
    quantities: [...qtys].sort((a, b) => a - b),
    price_table: table,
    allowed_addons: ['grommet'],
  }
}

// ── Booklets ─────────────────────────────────────────────────────────────────
// Two table styles:
//   A) Long header: "Base Price | 12pt Cover | 12pt Cover AQ | 12pt Cover UV" repeated for each page count
//   B) Single header: "8 Pages | 12 Pages | ... | 64 Pages" (one column per page count, base only)
function parseBooklets() {
  const rows = sheet('Booklets')
  const table = []
  const sizes = new Set(), stocks = new Set(), qtys = new Set(), pages = new Set(), covers = new Set()

  for (let i = 0; i < rows.length; i++) {
    const h = rows[i]
    if (h[1] !== 'Product Name') continue

    // Inspect previous row for "8 Pages","12 Pages" group spans (style A)
    const upper = i > 0 ? rows[i - 1] : []
    let style = 'B'
    if (upper.some(c => /\d+\s*Pages/i.test(String(c)))) style = 'A'

    // Build column → {pages, cover} map starting from col 5
    const colMap = []
    if (style === 'A') {
      // Walk upper row to find page-group anchors; each anchor spans 4 columns
      let currentPages = null
      for (let c = 5; c < h.length; c++) {
        const u = String(upper[c] || '')
        const m = u.match(/(\d+)\s*Pages/i)
        if (m) currentPages = parseInt(m[1])
        const sub = String(h[c] || '').trim()
        if (currentPages == null || !sub) continue
        let cover = 'base'
        if (/AQ/i.test(sub))      cover = 'aq'
        else if (/UV/i.test(sub)) cover = 'uv'
        else if (/12pt Cover/i.test(sub)) cover = '12pt'
        else if (/Base Price/i.test(sub)) cover = 'base'
        else continue
        colMap.push({ col: c, pages: currentPages, cover })
      }
    } else {
      for (let c = 5; c < h.length; c++) {
        const m = String(h[c] || '').match(/(\d+)\s*Pages/i)
        if (m) colMap.push({ col: c, pages: parseInt(m[1]), cover: 'base' })
      }
    }

    let size = null, stock = null
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[j]
      if (r[1] === 'Product Name') break
      if (!isNum(r[4])) continue
      if (trim(r[2])) size  = trim(r[2])
      if (trim(r[3])) stock = trim(r[3])
      const qty = r[4]
      qtys.add(qty); sizes.add(size); stocks.add(stock)
      for (const { col, pages: pg, cover } of colMap) {
        if (!isNum(r[col])) continue
        addPrice(table, { size, paper_stock: stock, pages: pg, cover }, qty, r[col])
        pages.add(pg); covers.add(cover)
      }
    }
  }

  return {
    label: 'Booklets',
    mode: 'lookup',
    lookup_keys: ['size', 'paper_stock', 'pages', 'cover'],
    options: {
      size:        [...sizes],
      paper_stock: [...stocks],
      pages:       [...pages].sort((a, b) => a - b),
      cover:       [...covers],
    },
    quantities: [...qtys].sort((a, b) => a - b),
    price_table: table,
    price_is_line_total: true,    // Booklets sheet stores line totals, not per-unit
  }
}

// ── NCR Forms ────────────────────────────────────────────────────────────────
// NCR uses a setup + slope cost model — not a lookup table.
//   line_total = setup[size][variant] + marginal_per_book[size] × qty
//              + book_wrap × qty + numbering × qty
// The values below are seeded from a linear fit of the published 5.5×8.5 data
// (qty 25 / 50 / 250 / 500, dropping the qty 100 anomaly):
//   slope ≈ $0.69 / book   ·   setup ≈ $80 / $90 / $125 / $125
function parseNCR() {
  const sizes = ['5.5x8.5', '8.5x11']
  const variants = [
    { key: '2part_single_color', label: '2 Part — Single Color' },
    { key: '2part_multi_color',  label: '2 Part — Multi Color' },
    { key: '3part_single_color', label: '3 Part — Single Color' },
    { key: '3part_multi_color',  label: '3 Part — Multi Color' },
  ]
  const setup = {}
  const marginal_per_book = {}
  for (const s of sizes) {
    setup[s] = {
      '2part_single_color':  80,
      '2part_multi_color':   90,
      '3part_single_color': 125,
      '3part_multi_color':  125,
    }
    marginal_per_book[s] = 0.69
  }

  return {
    label: 'NCR Forms',
    mode: 'ncr',
    options: {
      size:    sizes,
      variant: variants,
    },
    // Display-only quantity break points used by the price table generator
    quantities: [25, 50, 100, 250, 500, 1000],
    setup,
    marginal_per_book,
    allowed_addons: ['ncr_book_wrap', 'ncr_numbering'],
  }
}

// ── Coroplast ────────────────────────────────────────────────────────────────
// Coroplast is now a regular lookup product. Lookup keys:
//   thickness × size × variant
// where `variant` captures the mutually-exclusive combo of sides + finishing
// hardware (grommets / H-stand) — picking one excludes the others by design.
//
// Seeded with the published 4mm × 6×24 example. Other sizes/thicknesses appear
// as empty rows ready to be filled in via the editor.
function parseCoroplast() {
  const variants = [
    { key: '1_side',         label: '1 Side' },
    { key: '2_sides',        label: '2 Sides' },
    { key: 'grommet_top_2',  label: 'Grommets — Top 2 Corners' },
    { key: 'grommet_all_4',  label: 'Grommets — All 4 Corners' },
    { key: 'h_stand',        label: 'H Stand' },
  ]

  const thicknesses = ['4mm', '6mm', '10mm']
  const sizes = ['6x24', '12x12', '12x16', '12x18', '12x24', '18x24', '24x24', '24x36', '25x37', '48x60']
  const qtys  = [1, 2, 4, 8, 10, 16, 20, 30, 50]

  // Sample data for 4mm × 6x24 from your example
  const sample = {
    1:  { '1_side': 7.94, '2_sides': 8.47, 'grommet_top_2': 9.35, 'grommet_all_4': 10.77, 'h_stand': 9.25 },
    2:  { '1_side': 2.58, '2_sides': 5.90, 'grommet_top_2': 7.11, 'grommet_all_4':  8.52, 'h_stand': 9.83 },
    4:  { '1_side': 3.77, '2_sides': 4.30, 'grommet_top_2': 5.71, 'grommet_all_4':  7.13, 'h_stand': 8.44 },
    8:  { '1_side': 2.61, '2_sides': 3.06, 'grommet_top_2': 4.27, 'grommet_all_4':  5.47, 'h_stand': 6.58 },
    10: { '1_side': 2.49, '2_sides': 2.95, 'grommet_top_2': 4.15, 'grommet_all_4':  5.35, 'h_stand': 6.46 },
    16: { '1_side': 2.31, '2_sides': 2.77, 'grommet_top_2': 3.97, 'grommet_all_4':  5.17, 'h_stand': 6.28 },
    20: { '1_side': 2.21, '2_sides': 2.65, 'grommet_top_2': 3.86, 'grommet_all_4':  5.06, 'h_stand': 6.17 },
    30: { '1_side': 2.14, '2_sides': 2.58, 'grommet_top_2': 3.78, 'grommet_all_4':  4.98, 'h_stand': 6.09 },
    50: { '1_side': 2.03, '2_sides': 2.46, 'grommet_top_2': 3.66, 'grommet_all_4':  4.86, 'h_stand': 5.97 },
  }

  const price_table = []
  for (const t of thicknesses) {
    for (const s of sizes) {
      for (const v of variants) {
        const prices = {}
        if (t === '4mm' && s === '6x24') {
          for (const q of qtys) prices[q] = sample[q][v.key]
        }
        price_table.push({ key: { thickness: t, size: s, variant: v.key }, prices })
      }
    }
  }

  return {
    label: 'Coroplast',
    mode: 'lookup',
    lookup_keys: ['thickness', 'size', 'variant'],
    options: {
      thickness: thicknesses,
      size:      sizes,
      variant:   variants,
    },
    quantities: qtys,
    price_table,
    // Sheet imposition: how many pieces of each size fit on a 48x96 master
    // sheet. Reference data — not used by the price lookup itself, but
    // editable in the UI and useful for cost reasoning.
    sheet_imposition: {
      master: '48x96',
      pieces_per_sheet: {
        '48x60': 1, '25x37': 2, '24x36': 4, '24x24': 8, '18x24': 10,
        '12x24': 16, '12x18': 20, '12x16': 24, '12x12': 32,
      },
    },
    allowed_addons: [],   // grommets / H-stand are encoded in `variant`, not as add-ons
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function addPrice(table, key, qty, price) {
  let entry = table.find(e => sameKey(e.key, key))
  if (!entry) { entry = { key, prices: {} }; table.push(entry) }
  entry.prices[qty] = round4(price)
}
function sameKey(a, b) {
  const ak = Object.keys(a), bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every(k => a[k] === b[k])
}
function round4(n) { return Math.round(n * 10000) / 10000 }

// ── Build config ─────────────────────────────────────────────────────────────
const config = {
  globals: {
    turnaround: {
      regular:  { label: 'Regular',          multiplier: 1.0 },
      next_day: { label: 'Next Day',         multiplier: 1.2 },
      sameday:  { label: 'Same Day',         multiplier: 1.3 },
      '1_hour': { label: '1-Hour Delivery',  multiplier: 1.5 },
    },
    addons: {
      grommet:        { label: 'Grommets',                      type: 'flat_per_pc',  amount: 0.75 },
      h_stand:        { label: 'H-Stand',                       type: 'flat_per_pc',  amount: 1.31 },
      double_sided:   { label: 'Two-Sided Printing',            type: 'pct_of_base',  amount: 0.4  },
      ncr_book_wrap:  { label: 'NCR Book Wrap',                 type: 'flat_per_pc',  amount: 10   },
      ncr_numbering:  { label: 'NCR Numbering',                 type: 'flat_per_pc',  amount: 20   },
    },
    finishings: {
      no_finish:  { label: 'No Finish',             flat: 0,   per_unit: 0      },
      glossy_lam: { label: 'Glossy Lamination',     flat: 2.5, per_unit: 0.012  },
      matte_lam:  { label: 'Matte Lamination',      flat: 2.5, per_unit: 0.012  },
      soft_touch: { label: 'Soft Touch Lamination', flat: 4,   per_unit: 0.018  },
      spot_uv:    { label: 'Spot UV',               flat: 6,   per_unit: 0.025  },
      foil_gold:  { label: 'Gold Foil Stamping',    flat: 8,   per_unit: 0.03   },
      embossing:  { label: 'Embossing',             flat: 7,   per_unit: 0.028  },
    },
  },
  products: {
    brochure:      parseBrochure(),
    flyer:         parseFlyer(),
    business_card: parseBusinessCard(),
    booklets:      parseBooklets(),
    ncr_forms:     parseNCR(),
    coroplast:     parseCoroplast(),
  },
}

fs.writeFileSync(OUT, JSON.stringify(config, null, 2))
console.log(`Wrote ${OUT}`)
console.log('Products:', Object.keys(config.products).join(', '))
for (const [k, p] of Object.entries(config.products)) {
  if (p.mode === 'lookup') console.log(`  ${k}: ${p.price_table.length} table rows · ${p.quantities.length} qtys`)
  else                     console.log(`  ${k}: mode=${p.mode}`)
}
