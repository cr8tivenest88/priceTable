/**
 * Incremental importer for the second-round workbook.
 *
 *   node import-round2.js "2nd round 5 items April 10.xlsx"
 *
 * Reads the existing config.json, adds/updates only the new products
 * (foamcore / tickets / photo_frames / label / tshirt), and writes it
 * back — leaving all other products and admin edits untouched.
 *
 * A .bak of config.json is saved next to it before each write so you
 * can roll back by restoring the .bak.
 */

const fs   = require('fs')
const path = require('path')
const XLSX = require('xlsx')

const SRC         = process.argv[2] || '2nd round 5 items April 10.xlsx'
const CONFIG_PATH = path.join(__dirname, 'config.json')
const BAK_PATH    = CONFIG_PATH + '.bak'

const wb    = XLSX.readFile(path.resolve(SRC))
const sheet = name => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' })

const trim   = v => (typeof v === 'string' ? v.trim() : v)
const isNum  = v => typeof v === 'number' && !isNaN(v)
const round4 = n => Math.round(n * 10000) / 10000

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

// ── Foamcore ─────────────────────────────────────────────────────────────────
// Same shape as coroplast but simpler:
//   - Only 4mm thickness in this workbook
//   - Only small-size blocks (Qty + size header per block)
//   - 4 variants per block: 1 Side, 2 Sides, Grommet Top 2, Grommet All 4
//   - No H-Stand column, no big-size shared-Qty section
function parseFoamcore() {
  const rows = sheet('Foamcore')

  const VARIANT_MAP = {
    '1 Side':         '1_side',
    '2 Sides':        '2_sides',
    '2 side':         '2_sides',
    'Top 2 Corners':  'grommet_top_2',
    'All 4 Corners':  'grommet_all_4',
  }
  const variants = [
    { key: '1_side',         label: '1 Side' },
    { key: '2_sides',        label: '2 Sides' },
    { key: 'grommet_top_2',  label: 'Grommets — Top 2 Corners' },
    { key: 'grommet_all_4',  label: 'Grommets — All 4 Corners' },
  ]

  // A thickness section starts with a row containing 'Qty' cells followed by
  // a variant row containing '1 Side' / '2 Sides'. Thickness is read from the
  // first column of the first data row below ("4mm Foamcore" etc.).
  const sections = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r.some(c => String(c).trim() === 'Qty')) continue
    const vNext = rows[i + 1] || []
    if (!vNext.some(c => /1 Side|2 Sides/i.test(String(c)))) continue
    const dataRow = rows[i + 2] || []
    const thickMatch = String(dataRow[0] || '').match(/(\d+mm)/i)
    if (thickMatch) {
      sections.push({ headerRow: i, variantRow: i + 1, thickness: thickMatch[1].toLowerCase() })
    }
  }

  const allSizes       = new Set()
  const allThicknesses = new Set()
  const qtys           = new Set()
  const price_table    = []

  for (const sec of sections) {
    const hRow = rows[sec.headerRow]
    const vRow = rows[sec.variantRow]
    const thick = sec.thickness
    allThicknesses.add(thick)

    // Each 'Qty' cell is the start of a size block. The next cell is the size,
    // followed by the variant columns.
    const blocks = []
    for (let c = 0; c < hRow.length; c++) {
      if (String(hRow[c]).trim() !== 'Qty') continue
      const sizeRaw = String(hRow[c + 1] || '').trim().replace(/X/g, 'x')
      if (!/^\d+x\d+$/.test(sizeRaw)) continue

      const varCols = []
      for (let v = c + 1; v < c + 8 && v < hRow.length; v++) {
        const name = String(vRow[v] || '').trim()
        if (VARIANT_MAP[name]) varCols.push({ col: v, variant: VARIANT_MAP[name] })
      }
      if (varCols.length >= 2) blocks.push({ qtyCol: c, size: sizeRaw, varCols })
    }

    // Read data rows until we hit a non-foamcore label
    for (let r = sec.variantRow + 1; r < rows.length; r++) {
      const row = rows[r]
      const label = String(row[0] || '').trim()
      if (!label) break
      if (!label.toLowerCase().includes('foamcore')) break

      for (const block of blocks) {
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

  // Pieces per 48×96 master sheet — borrowed from coroplast where sizes match.
  const pieces_per_sheet = {
    '6x24':  32, '6x32':  24, '6x36':  21,
    '12x12': 32, '12x16': 24, '12x18': 21,
    '12x36': 10, '12x48': 8,
  }

  return {
    label: 'Foamcore',
    mode: 'lookup',
    lookup_keys: ['thickness', 'size', 'variant'],
    options: {
      thickness: [...allThicknesses],
      size:      [...allSizes],
      variant:   variants,
    },
    quantities: [...qtys].sort((a, b) => a - b),
    price_table,
    sheet_imposition: { master: '48x96', pieces_per_sheet },
    allowed_addons:      [],
    allowed_finishings:  ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
  }
}

// ── Tickets (Event Tickets) ──────────────────────────────────────────────────
// Stacked-block layout, one block per size. Each block has a header row:
//   [_, Size, Paper Stock, Qty, Front, Front & Back]
// followed by data rows sharing size + paper stock. Blocks are separated by
// blank rows. Sides map to 'front' / 'front_back'.
function parseTickets() {
  const rows = sheet('Tickets')
  const price_table = []
  const sizes = new Set(), stocks = new Set(), qtys = new Set()

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (trim(r[1]) !== 'Size' || !/Front/i.test(String(r[4]))) continue

    for (let j = i + 1; j < rows.length; j++) {
      const d = rows[j]
      const size  = trim(d[1])
      const stock = trim(d[2])
      const qty   = d[3]
      if (!size || !isNum(qty)) break

      const cleanStock = String(stock).replace(/[\r\n]+/g, '').trim()
      sizes.add(size)
      stocks.add(cleanStock)
      qtys.add(qty)

      // Store as 'single' / 'double' to match the flyer convention the engine
      // uses for the Sides dropdown. Display labels keep the 'Front' wording.
      const front    = d[4]
      const frontBak = d[5]
      if (isNum(front))    addPrice(price_table, { size, paper_stock: cleanStock, sides: 'single' }, qty, front)
      if (isNum(frontBak)) addPrice(price_table, { size, paper_stock: cleanStock, sides: 'double' }, qty, frontBak)
    }
  }

  return {
    label: 'Event Tickets',
    mode: 'lookup',
    lookup_keys: ['size', 'paper_stock', 'sides'],
    options: {
      size:        [...sizes],
      paper_stock: [...stocks],
      sides: [
        { key: 'single', label: 'Front' },
        { key: 'double', label: 'Front & Back' },
      ],
    },
    quantities: [...qtys].sort((a, b) => a - b),
    price_table,
    allowed_addons:      [],
    allowed_finishings:  ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
  }
}

// ── Photo Frames ─────────────────────────────────────────────────────────────
// Layout: row 0 = size headers (spanning 2 cols each: Price, Value),
//         row 1 = 'Price'/'Value' sub-headers,
//         rows 2..N = Qty (col 0) + per-size (Price, Value) pairs.
// Only the Price column matters — Value is just qty × price (redundant).
// Size headers look like '8" x 8" l 20 x 20 cm' — we clean to '8x8'.
function parseFrames() {
  const rows = sheet('Photo Frames')
  if (!rows.length) throw new Error('Photo Frames sheet empty')

  const header = rows[0]
  const blocks = []  // { col, size }
  for (let c = 1; c < header.length; c++) {
    const cell = String(header[c] || '').trim()
    if (!cell) continue
    const m = cell.match(/(\d+(?:\.\d+)?)\s*["'']?\s*x\s*(\d+(?:\.\d+)?)/i)
    if (!m) continue
    blocks.push({ col: c, size: `${m[1]}x${m[2]}` })
  }

  const sizes = [...new Set(blocks.map(b => b.size))]
  const qtys  = new Set()
  const price_table = []

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r]
    const qty = row[0]
    if (!isNum(qty)) continue
    qtys.add(qty)
    for (const block of blocks) {
      const price = row[block.col]
      if (!isNum(price) || price <= 0) continue
      addPrice(price_table, { size: block.size }, qty, price)
    }
  }

  return {
    label: 'Photo Frames',
    mode: 'lookup',
    lookup_keys: ['size'],
    options: { size: sizes },
    quantities: [...qtys].sort((a, b) => a - b),
    price_table,
    allowed_addons:      [],
    allowed_finishings:  ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
  }
}

// ── Labels ───────────────────────────────────────────────────────────────────
// Same shape as Photo Frames — QUANTITY rows × (size × [Price, Value]) cols.
// Sizes are circular diameters like '0.5" dia | 1.27 cm' → cleaned to '0.5"'.
function parseLabels() {
  const rows = sheet('label')
  if (!rows.length) throw new Error('label sheet empty')

  const header = rows[0]
  const blocks = []
  for (let c = 1; c < header.length; c++) {
    const cell = String(header[c] || '').trim()
    if (!cell) continue
    const m = cell.match(/(\d+(?:\.\d+)?)\s*["'']?\s*dia/i)
    if (!m) continue
    blocks.push({ col: c, size: `${m[1]}"` })
  }

  const sizes = [...new Set(blocks.map(b => b.size))]
  const qtys  = new Set()
  const price_table = []

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r]
    const qty = row[0]
    if (!isNum(qty)) continue
    qtys.add(qty)
    for (const block of blocks) {
      const price = row[block.col]
      if (!isNum(price) || price <= 0) continue
      addPrice(price_table, { size: block.size }, qty, price)
    }
  }

  return {
    label: 'Labels',
    mode: 'lookup',
    lookup_keys: ['size'],
    options: { size: sizes },
    quantities: [...qtys].sort((a, b) => a - b),
    price_table,
    allowed_addons:      [],
    allowed_finishings:  ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
  }
}

// ── T-Shirts ─────────────────────────────────────────────────────────────────
// Two blocks with different column layouts:
//
//   Block A (art_size = 8x10, rows 1..14)
//     Row 1: item | size | Colour | Small (×4 cols) | Medium (×4) | Large (×4)
//            | X-Large (×4) | 2X-Large (×4)
//     Row 2: Front/Back | Front/Back/Sameday | Both | Both Sameday  — repeating
//     Rows 3..14: 12 colours, each with a price per (shirt_size × print_option)
//
//   Block B (art_size = 3x3, rows 17..30)
//     Row 17: item | size | Colour | Small (×2) | Medium (×2) | Large (×2)
//             | X-Large (×2) | 2X-Large (×2)
//     Row 18: Base Price | Same day  — repeating
//     Rows 19..30: 12 colours, each with a price per (shirt_size × turnaround).
//     3x3 only has a single-side option (too small for 'Both').
//
// Output schema uses the flyer convention for sides: 'single' / 'double',
// plus a sameday_prices map parallel to prices for the sameday turnaround.
function parseTshirt() {
  const rows = sheet('T Shirt')

  // Canonical shirt-size key from header text
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const cleanColor = c => String(c).trim()

  const shirtSizeMap = {
    'small':     { key: 'small',    label: 'Small' },
    'medium':    { key: 'medium',   label: 'Medium' },
    'large':     { key: 'large',    label: 'Large' },
    'x_large':   { key: 'x_large',  label: 'X-Large' },
    '2x_large':  { key: '2x_large', label: '2X-Large' },
  }

  const price_table = []
  const artSizes = new Set()
  const colors = new Map()     // key → { key, label }
  const shirtSizes = new Map() // key → { key, label }

  // Add or merge an entry's prices
  function pushEntry(key, tn, unit) {
    if (!isNum(unit) || unit <= 0) return
    let entry = price_table.find(e => sameKey(e.key, key))
    if (!entry) {
      entry = { key, prices: {}, sameday_prices: {} }
      price_table.push(entry)
    }
    if (tn === 'regular') entry.prices[1] = round4(unit)
    else                  entry.sameday_prices[1] = round4(unit)
  }

  // Find the header rows that start each block. A header row has 'item' in
  // col 0, 'Colour' in col 2, and shirt-size names in later columns.
  const headerRows = []
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    if (trim(row[0]) !== 'item') continue
    if (String(row[2]).trim().toLowerCase() !== 'colour') continue
    headerRows.push(r)
  }

  for (const hdrRow of headerRows) {
    const sizeRow = rows[hdrRow]      // 'Small', 'Medium', ..., '2X-Large'
    const subRow  = rows[hdrRow + 1]  // 'Front/Back' or 'Base Price'

    // Detect block type by looking at the sub-header text
    const subText = (subRow || []).map(c => String(c || '').toLowerCase()).join(' ')
    const isBigBlock = /both/.test(subText)   // 8x10 block has 'Both' in sub-headers

    // Each shirt-size header position tells us where that shirt-size's price
    // columns start. Columns per shirt-size:
    //   Big block (8x10): 4 cols → FB-reg, FB-sameday, Both-reg, Both-sameday
    //   Small block (3x3): 2 cols → Base, Sameday
    const shirtStarts = []
    for (let c = 3; c < sizeRow.length; c++) {
      const label = trim(sizeRow[c])
      if (!label) continue
      const k = slug(label)
      if (!shirtSizeMap[k]) continue
      shirtStarts.push({ col: c, key: shirtSizeMap[k].key, label: shirtSizeMap[k].label })
    }

    // Data rows until a non-matching first column
    for (let r = hdrRow + 2; r < rows.length; r++) {
      const row = rows[r]
      const item  = trim(row[0])
      const aSize = trim(row[1])
      const color = cleanColor(row[2])
      if (!item || !aSize || !color) break
      if (!/t.?shirt/i.test(item)) break

      artSizes.add(aSize)
      const colorKey = slug(color)
      if (!colors.has(colorKey)) colors.set(colorKey, { key: colorKey, label: color })

      for (const ss of shirtStarts) {
        if (!shirtSizes.has(ss.key)) shirtSizes.set(ss.key, shirtSizeMap[slug(ss.label)])

        if (isBigBlock) {
          // 4 cols: FB-reg, FB-sameday, Both-reg, Both-sameday
          pushEntry({ art_size: aSize, color: colorKey, shirt_size: ss.key, sides: 'single' }, 'regular', row[ss.col + 0])
          pushEntry({ art_size: aSize, color: colorKey, shirt_size: ss.key, sides: 'single' }, 'sameday', row[ss.col + 1])
          pushEntry({ art_size: aSize, color: colorKey, shirt_size: ss.key, sides: 'double' }, 'regular', row[ss.col + 2])
          pushEntry({ art_size: aSize, color: colorKey, shirt_size: ss.key, sides: 'double' }, 'sameday', row[ss.col + 3])
        } else {
          // 2 cols: Base (regular single), Same day (sameday single) — no 'Both'
          pushEntry({ art_size: aSize, color: colorKey, shirt_size: ss.key, sides: 'single' }, 'regular', row[ss.col + 0])
          pushEntry({ art_size: aSize, color: colorKey, shirt_size: ss.key, sides: 'single' }, 'sameday', row[ss.col + 1])
        }
      }
    }
  }

  // Order: preserve iteration order of the Maps/Sets
  const orderedShirtSizes = ['small', 'medium', 'large', 'x_large', '2x_large']
    .filter(k => shirtSizes.has(k)).map(k => shirtSizes.get(k))

  return {
    label: 'T-Shirts',
    mode: 'lookup',
    lookup_keys: ['art_size', 'color', 'shirt_size', 'sides'],
    options: {
      art_size:   [...artSizes],
      color:      [...colors.values()],
      shirt_size: orderedShirtSizes,
      sides: [
        { key: 'single', label: 'Single Side (Front or Back)' },
        { key: 'double', label: 'Both Sides (Front + Back)' },
      ],
    },
    quantities: [1],
    price_table,
    prices_include_turnaround: true,   // engine flag: use entry.sameday_prices directly
    allowed_addons:      [],
    allowed_finishings:  ['no_finish'],
    allowed_turnarounds: ['regular', 'sameday'],
  }
}

// ── Merge into existing config ───────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

// Safety backup (ignored by .gitignore)
fs.writeFileSync(BAK_PATH, JSON.stringify(config, null, 2))

config.products.foamcore     = parseFoamcore()
config.products.tickets      = parseTickets()
config.products.photo_frames = parseFrames()
config.products.labels       = parseLabels()
config.products.tshirts      = parseTshirt()

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))

console.log(`Wrote ${CONFIG_PATH} (backup: ${BAK_PATH})`)
for (const key of ['foamcore', 'tickets', 'photo_frames', 'labels']) {
  const p = config.products[key]
  console.log(`${key}: ${p.price_table.length} table rows · ${p.quantities.length} qtys · sizes=${p.options.size.length}`)
  console.log(`  sizes: ${p.options.size.join(', ')}`)
  console.log(`  qtys:  ${p.quantities.join(', ')}`)
}
const ts = config.products.tshirts
console.log(`tshirts: ${ts.price_table.length} table rows · ${ts.options.art_size.length} art sizes · ` +
            `${ts.options.color.length} colors · ${ts.options.shirt_size.length} shirt sizes`)
console.log(`  art sizes:   ${ts.options.art_size.join(', ')}`)
console.log(`  shirt sizes: ${ts.options.shirt_size.map(s => s.label).join(', ')}`)
console.log(`  colors:      ${ts.options.color.map(c => c.label).join(', ')}`)
