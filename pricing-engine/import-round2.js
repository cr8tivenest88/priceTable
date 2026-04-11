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

// ── Merge into existing config ───────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

// Safety backup (ignored by .gitignore)
fs.writeFileSync(BAK_PATH, JSON.stringify(config, null, 2))

config.products.foamcore = parseFoamcore()
config.products.tickets  = parseTickets()

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))

const fc = config.products.foamcore
const tk = config.products.tickets
console.log(`Wrote ${CONFIG_PATH} (backup: ${BAK_PATH})`)
console.log(`foamcore: ${fc.price_table.length} table rows · ${fc.quantities.length} qtys · ` +
            `sizes=${fc.options.size.length} · thicknesses=${fc.options.thickness.length}`)
console.log(`  thicknesses: ${fc.options.thickness.join(', ')}`)
console.log(`  sizes:       ${fc.options.size.join(', ')}`)
console.log(`  qtys:        ${fc.quantities.join(', ')}`)
console.log(`tickets:  ${tk.price_table.length} table rows · ${tk.quantities.length} qtys · ` +
            `sizes=${tk.options.size.length} · stocks=${tk.options.paper_stock.length}`)
console.log(`  sizes:       ${tk.options.size.join(', ')}`)
console.log(`  stocks:      ${tk.options.paper_stock.join(' | ')}`)
console.log(`  qtys:        ${tk.quantities.join(', ')}`)
