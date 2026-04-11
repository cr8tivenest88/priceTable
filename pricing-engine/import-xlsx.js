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
// Coroplast layout: each thickness section (4mm, 6mm, 8mm, 10mm) has:
//   - Small sizes (6x24..12x48): each has its own Qty column + 5 variant cols
//     (1 Side, 2 Sides, Grommet Top 2, Grommet All 4, H Stand)
//   - Big sizes (18x24..48x96): share one Qty column + 2 variant cols each
//     (1 Side, 2 Sides only)
// Each thickness section repeats the same column layout; headers appear in
// rows 1-2 (4mm), 14-15 (6mm), 26-27 (8mm), 39-40 (10mm).
function parseCoroplast() {
  const rows = sheet('Coroplast')

  const VARIANT_MAP = {
    '1 Side':         '1_side',
    '2 Sides':        '2_sides',
    '2 side':         '2_sides',
    'Top 2 Corners':  'grommet_top_2',
    'All 4 Corners':  'grommet_all_4',
    'H Stand':        'h_stand',
  }

  const variants = [
    { key: '1_side',         label: '1 Side' },
    { key: '2_sides',        label: '2 Sides' },
    { key: 'grommet_top_2',  label: 'Grommets — Top 2 Corners' },
    { key: 'grommet_all_4',  label: 'Grommets — All 4 Corners' },
    { key: 'h_stand',        label: 'H Stand' },
  ]

  // Find all thickness sections — each starts with a header row pair
  const sections = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    // Header row has 'Qty' in col 1 and a size name in col 2
    if (String(r[1]).trim() === 'Qty' && /^\d+[xX]\d+$/i.test(String(r[2]).trim())) {
      // Find the thickness from the first data row below the variant-header row
      const dataRow = rows[i + 2] || []
      const thickMatch = String(dataRow[0] || '').match(/(\d+mm)\s/i)
      if (thickMatch) {
        sections.push({ headerRow: i, variantRow: i + 1, thickness: thickMatch[1].toLowerCase() })
      }
    }
  }

  const allSizes = new Set()
  const allThicknesses = new Set()
  const qtys = new Set()
  const price_table = []

  for (const sec of sections) {
    const hRow = rows[sec.headerRow]
    const vRow = rows[sec.variantRow]
    const thick = sec.thickness
    allThicknesses.add(thick)

    // Build column map for small sizes (have their own Qty col)
    const smallBlocks = []
    for (let c = 0; c < hRow.length; c++) {
      if (String(hRow[c]).trim() !== 'Qty') continue
      const sizeRaw = String(hRow[c + 1] || '').trim()
      let size = sizeRaw
      // Fix "1248" → "12x48", "12X12" → "12x12"
      if (/^\d{3,}$/.test(size)) {
        // Try longer widths first to avoid e.g. 6x248 instead of 12x48
        for (const w of [48, 36, 32, 25, 24, 18, 12, 6]) {
          const prefix = String(w)
          if (size.startsWith(prefix) && size.length > prefix.length) {
            const rest = size.slice(prefix.length)
            if (/^\d{2,}$/.test(rest)) { size = `${w}x${rest}`; break }
          }
        }
      }
      size = size.replace(/X/, 'x')
      if (!/^\d+x\d+$/.test(size)) continue

      // Collect variant columns. Small-size blocks have "Grommets" or "H Stand"
      // in the header row within the block's columns. If those keywords are absent,
      // this is the big-sizes shared Qty column — skip it.
      const varCols = []
      let hasGrommetOrStand = false
      for (let v = c + 1; v < c + 8 && v < hRow.length; v++) {
        const hCell = String(hRow[v] || '').trim()
        if (/Grommet/i.test(hCell) || /H Stand/i.test(hCell)) hasGrommetOrStand = true
        const name = String(vRow[v] || '').trim()
        if (VARIANT_MAP[name]) varCols.push({ col: v, variant: VARIANT_MAP[name] })
      }
      if (varCols.length >= 3 && hasGrommetOrStand) smallBlocks.push({ qtyCol: c, size, varCols })
    }

    // Build column map for big sizes — they share a single Qty column and each
    // size occupies 2 cols (1 side, 2 sides). Detect the shared Qty col as the
    // last 'Qty' in the header row (small sizes have earlier Qty cols).
    let bigQtyCol = null
    const bigBlocks = []
    // Find the last Qty column — that's the one shared by all big sizes
    for (let c = hRow.length - 1; c >= 0; c--) {
      if (String(hRow[c]).trim() === 'Qty') {
        // Make sure it's not a small-size Qty (those have a size name right after)
        const nextCell = String(hRow[c + 1] || '').trim().replace(/X/g, 'x')
        const isSmall = smallBlocks.some(b => b.qtyCol === c)
        if (!isSmall) { bigQtyCol = c; break }
      }
    }
    if (bigQtyCol != null) {
      for (let c = bigQtyCol + 1; c < hRow.length; c++) {
        const cell = String(hRow[c] || '').trim().replace(/X/g, 'x')
        if (/^\d+x\d+$/i.test(cell)) {
          bigBlocks.push({
            qtyCol: bigQtyCol,
            size: cell,
            varCols: [
              { col: c, variant: '1_side' },
              { col: c + 1, variant: '2_sides' },
            ],
          })
          c++ // skip the 2-sides column
        }
      }
    }

    const allBlocks = [...smallBlocks, ...bigBlocks]

    // Read data rows for this thickness section
    for (let r = sec.variantRow + 1; r < rows.length; r++) {
      const row = rows[r]
      const label = String(row[0] || '').trim()
      if (!label) break // empty row = end of section
      if (!label.toLowerCase().includes('coroplast')) break

      for (const block of allBlocks) {
        const qty = row[block.qtyCol]
        if (!isNum(qty)) continue
        qtys.add(qty)
        allSizes.add(block.size)

        for (const vc of block.varCols) {
          const price = row[vc.col]
          if (!isNum(price) || price <= 0) continue
          addPrice(price_table, { thickness: thick, size: block.size, variant: vc.variant }, qty, price)
        }
      }
    }
  }

  // Pieces per sheet — hardcoded from the Excel's imposition reference row.
  // Small sizes calculated by fitting on 48x96 master sheet.
  const pieces_per_sheet = {
    '6x24': 32, '6x32': 24, '6x36': 21,
    '12x12': 32, '12x16': 24, '12x18': 21, '12x36': 10, '12x48': 8,
    '18x24': 10, '24x24': 8, '24x36': 4, '24x48': 4,
    '25x37': 2, '32x48': 2, '36x36': 2, '36x48': 2,
    '48x48': 2, '48x60': 1, '48x72': 1, '48x96': 1,
  }

  return {
    label: 'Coroplast',
    mode: 'lookup',
    lookup_keys: ['thickness', 'size', 'variant'],
    options: {
      thickness: [...allThicknesses],
      size:      [...allSizes],
      variant:   variants,
    },
    quantities: [...qtys].sort((a, b) => a - b),
    price_table,
    sheet_imposition: {
      master: '48x96',
      pieces_per_sheet,
    },
    allowed_addons: [],
    allowed_finishings: ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
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
