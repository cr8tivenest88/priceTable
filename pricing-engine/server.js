const express  = require('express')
const fs       = require('fs')
const path     = require('path')
const { calculatePrice, buildPriceTable, generateAllCombos, loadConfig } = require('./engine')

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

// POST /api/all-combos — every spec × finishing × qty combination
app.post('/api/all-combos', (req, res) => {
  try {
    const rows = generateAllCombos(req.body)
    res.json(rows)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`Pricing engine running at http://localhost:${PORT}`)
})
