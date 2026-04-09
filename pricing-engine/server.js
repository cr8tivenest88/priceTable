const express  = require('express')
const fs       = require('fs')
const path     = require('path')
const XLSX     = require('xlsx')
const { calculatePrice, buildPriceTable, generateAllCombos, generateAllCombosMulti, loadConfig } = require('./engine')

const app  = express()
const PORT = 3000

app.use(express.json())
app.use(express.static(path.join(__dirname, 'client')))

// ── Config endpoints ──────────────────────────────────────────────────────────

// GET full config
app.get('/api/config', (req, res) => {
  res.json(loadConfig())
})

// PUT full config (save from admin UI)
app.put('/api/config', (req, res) => {
  try {
    const configPath = path.join(__dirname, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Pricing endpoints ─────────────────────────────────────────────────────────

// POST /api/price — single price lookup
app.post('/api/price', (req, res) => {
  try {
    const result = calculatePrice(req.body)
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/price-table — full table for a product + spec combo
app.post('/api/price-table', (req, res) => {
  try {
    const table = buildPriceTable(req.body)
    res.json(table)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/all-combos — every spec × finishing × qty combination (one turnaround)
app.post('/api/all-combos', (req, res) => {
  try {
    const rows = generateAllCombos(req.body)
    res.json(rows)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/all-combos-multi — same enumeration, but one row per combo with a
// `byTurnaround` map of all allowed turnaround prices. ~N× faster than calling
// /api/all-combos N times when N = number of allowed turnarounds.
app.post('/api/all-combos-multi', (req, res) => {
  try {
    const rows = generateAllCombosMulti(req.body)
    res.json(rows)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/export-xlsx — flat lookup table for one product (optionally filtered
// by size + sides) downloaded as an .xlsx file. One Line/Unit column pair per
// allowed turnaround.
app.post('/api/export-xlsx', (req, res) => {
  try {
    const { product, size, sides, markup = 0 } = req.body
    const config = loadConfig()
    const productCfg = config.products[product]
    if (!productCfg) return res.status(400).json({ error: `Unknown product: ${product}` })

    const turnarounds = (productCfg.allowed_turnarounds && productCfg.allowed_turnarounds.length)
      ? productCfg.allowed_turnarounds
      : Object.keys(config.globals.turnaround || {})

    // Single multi-turnaround pass — much faster than N separate generateAllCombos calls
    let rowsArr = generateAllCombosMulti({ product, markup, sides })
    if (size) rowsArr = rowsArr.filter(r => r.specs.size === size)
    const otherKeys = productCfg.lookup_keys
      ? productCfg.lookup_keys.filter(k => k !== 'size')
      : (productCfg.mode === 'ncr' ? ['variant'] : [])
    const labelOf = (key, value) => {
      const opt = (productCfg.options?.[key] || []).find(o => (typeof o === 'object' ? o.key : o) === value)
      return opt && typeof opt === 'object' ? opt.label : value
    }
    const finLabel = k => config.globals.finishings[k]?.label || k
    const tnLabel  = k => config.globals.turnaround[k]?.label || k

    const data = rowsArr.map(r => {
      const row = { Size: r.specs.size }
      for (const k of otherKeys) {
        row[k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())] = labelOf(k, r.specs[k])
      }
      row.Qty       = r.qty
      row.Finishing = finLabel(r.finishing)
      for (const tn of turnarounds) {
        const p = r.byTurnaround[tn]
        row[`${tnLabel(tn)} (Line $)`] = p?.sellPrice ?? ''
        row[`${tnLabel(tn)} ($/u)`]    = p?.unitSellPrice ?? ''
      }
      return row
    })

    // Sort by combo → qty → finishing for stable output
    data.sort((a, b) =>
      String(a.Size).localeCompare(String(b.Size)) ||
      otherKeys.reduce((acc, k) => acc || String(a[k] ?? '').localeCompare(String(b[k] ?? '')), 0) ||
      a.Qty - b.Qty ||
      String(a.Finishing).localeCompare(String(b.Finishing))
    )

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, productCfg.label.slice(0, 30) || 'Prices')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

    const safeName = `${productCfg.label}${size ? '-' + size : ''}-${sides || 1}sided.xlsx`
      .replace(/[^a-z0-9.-]+/gi, '_')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
    res.send(buf)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`Pricing engine running at http://localhost:${PORT}`)
})
