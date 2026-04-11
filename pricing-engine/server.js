const express     = require('express')
const compression = require('compression')
const crypto      = require('crypto')
const fs          = require('fs')
const path        = require('path')
const XLSX        = require('xlsx')
const { calculatePrice, buildPriceTable, generateAllCombos, generateAllCombosMulti, loadConfig } = require('./engine')

const BACKUP_DIR  = path.join(__dirname, 'backups')
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR)

const app  = express()
const PORT = 3000

app.use(compression())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'client'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // JS/CSS: revalidate every request (ETag handles 304), so edits show up immediately
    if (/\.(js|css|html)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache')
    }
  },
}))

// ── Config endpoints ──────────────────────────────────────────────────────────

// GET full config
app.get('/api/config', (req, res) => {
  res.json(loadConfig())
})

// ── Backup helpers ───────────────────────────────────────────────────────────

function createBackup(label) {
  const id   = crypto.randomUUID()
  const meta = {
    id,
    label: label || 'Auto-backup',
    timestamp: new Date().toISOString(),
  }
  const configData = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')
  const backupPath = path.join(BACKUP_DIR, `${id}.json`)
  fs.writeFileSync(backupPath, JSON.stringify({ meta, config: JSON.parse(configData) }, null, 2))
  return meta
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return []
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const raw = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'))
      return raw.meta
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

// PUT full config (save from admin UI) — auto-backup before overwrite
app.put('/api/config', (req, res) => {
  try {
    const configPath = path.join(__dirname, 'config.json')
    createBackup('Before save')
    fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/backup — create a named backup
app.post('/api/backup', (req, res) => {
  try {
    const meta = createBackup(req.body.label || 'Manual backup')
    res.json(meta)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/backups — list all backups
app.get('/api/backups', (req, res) => {
  res.json(listBackups())
})

// POST /api/restore/:id — restore config from a backup UUID
app.post('/api/restore/:id', (req, res) => {
  try {
    const backupPath = path.join(BACKUP_DIR, `${req.params.id}.json`)
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' })
    // backup current state before restoring
    createBackup('Before restore')
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(backup.config, null, 2))
    res.json({ ok: true, restored: backup.meta })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /api/backup/:id — delete a backup
app.delete('/api/backup/:id', (req, res) => {
  try {
    const backupPath = path.join(BACKUP_DIR, `${req.params.id}.json`)
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' })
    fs.unlinkSync(backupPath)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/backup/:id/download — download a backup as .json file
app.get('/api/backup/:id/download', (req, res) => {
  try {
    const backupPath = path.join(BACKUP_DIR, `${req.params.id}.json`)
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' })
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    const safeName = `config-backup-${backup.meta.timestamp.slice(0, 10)}-${req.params.id.slice(0, 8)}.json`
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
    res.send(JSON.stringify(backup.config, null, 2))
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

// POST /api/export-xlsx — download price table as .xlsx. Layouts mirror the
// on-screen Price Table tab:
//   - coroplast → one sheet per turnaround, rows = thickness × qty, cols = variants
//   - ncr       → one sheet per turnaround, rows = size × variant × qty, cols = add-on combos
//   - other     → flat table, one row per combo, one Line/Unit pair per turnaround
app.post('/api/export-xlsx', (req, res) => {
  try {
    const { product, size, sides, markup = 0 } = req.body
    const config = loadConfig()
    const productCfg = config.products[product]
    if (!productCfg) return res.status(400).json({ error: `Unknown product: ${product}` })

    const turnarounds = (productCfg.allowed_turnarounds && productCfg.allowed_turnarounds.length)
      ? productCfg.allowed_turnarounds
      : Object.keys(config.globals.turnaround || {})

    const tnLabel = k => config.globals.turnaround[k]?.label || k
    const wb = XLSX.utils.book_new()

    // ── Coroplast / Foamcore: pivoted layout, one sheet per turnaround ─────
    const isPivotVariant = (productCfg.lookup_keys || []).join(',') === 'thickness,size,variant'
    if (isPivotVariant) {
      const variants = productCfg.options?.variant || []
      const thicks   = productCfg.options?.thickness || []
      const varKey   = v => typeof v === 'object' ? v.key : v
      const varLabel = v => typeof v === 'object' ? v.label : v

      let rowsArr = generateAllCombosMulti({ product, markup, sides })
      if (size) rowsArr = rowsArr.filter(r => r.specs.size === size)
      const sizes = size ? [size] : [...new Set(rowsArr.map(r => r.specs.size))]

      for (const tn of turnarounds) {
        const aoa = [['Product Name', 'Size', 'Thickness', 'Qty', ...variants.map(varLabel)]]
        for (const sz of sizes) {
          for (const t of thicks) {
            const qtys = [...new Set(rowsArr
              .filter(r => r.specs.thickness === t && r.specs.size === sz)
              .map(r => r.qty))].sort((a, b) => a - b)
            for (const q of qtys) {
              const row = [productCfg.label, sz, t, q]
              for (const v of variants) {
                const match = rowsArr.find(r =>
                  r.specs.thickness === t && r.specs.size === sz &&
                  r.specs.variant === varKey(v) && r.qty === q)
                row.push(match?.byTurnaround?.[tn]?.sellPrice ?? '')
              }
              aoa.push(row)
            }
          }
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa)
        XLSX.utils.book_append_sheet(wb, ws, tnLabel(tn).slice(0, 30))
      }
    }

    // ── T-shirts: one sheet per (art_size × turnaround), rows = colours,
    //    cols = shirt_size × sides. Mirrors the on-screen layout. ───────────
    else if (productCfg.prices_include_turnaround &&
             (productCfg.lookup_keys || []).join(',') === 'art_size,color,shirt_size,sides') {
      const colors     = productCfg.options?.color      || []
      const shirtSizes = productCfg.options?.shirt_size || []
      const artSizes   = productCfg.options?.art_size   || []
      const sideOpts   = productCfg.options?.sides      || []
      const lbl = o => typeof o === 'object' ? o.label : o
      const kOf = o => typeof o === 'object' ? o.key   : o

      const rowsArr = generateAllCombosMulti({ product, markup })
      const map = {}
      for (const r of rowsArr) {
        const a = r.specs.art_size, c = r.specs.color, ss = r.specs.shirt_size, sd = r.specs.sides
        for (const tn of turnarounds) {
          const p = r.byTurnaround?.[tn]
          if (!p) continue
          ;((((map[a] = map[a] || {})[c] = map[a][c] || {})[ss] = map[a][c][ss] || {})[sd] = map[a][c][ss][sd] || {})[tn] = p
        }
      }

      for (const a of artSizes) {
        const presentSides = sideOpts.filter(s =>
          colors.some(c => shirtSizes.some(ss => map[a]?.[kOf(c)]?.[kOf(ss)]?.[kOf(s)]))
        )
        if (!presentSides.length) continue
        for (const tn of turnarounds) {
          // Two header rows: shirt-size spans, then side-option sub-headers.
          const topHeader = ['Product Name', 'Art Size', 'Colour']
          const subHeader = ['',             '',         '']
          for (const ss of shirtSizes) {
            topHeader.push(lbl(ss))
            for (let i = 1; i < presentSides.length; i++) topHeader.push('')
            for (const s of presentSides) subHeader.push(lbl(s))
          }
          const aoa = [topHeader, subHeader]
          for (const c of colors) {
            const row = [productCfg.label, a, lbl(c)]
            for (const ss of shirtSizes) {
              for (const s of presentSides) {
                const cell = map[a]?.[kOf(c)]?.[kOf(ss)]?.[kOf(s)]?.[tn]
                row.push(cell?.sellPrice ?? '')
              }
            }
            aoa.push(row)
          }
          const ws = XLSX.utils.aoa_to_sheet(aoa)
          // Merge the shirt-size header cells across their sides columns
          if (presentSides.length > 1) {
            ws['!merges'] = ws['!merges'] || []
            for (let i = 0; i < shirtSizes.length; i++) {
              const startCol = 3 + i * presentSides.length
              ws['!merges'].push({ s: { r: 0, c: startCol }, e: { r: 0, c: startCol + presentSides.length - 1 } })
            }
          }
          const name = `${a} ${tnLabel(tn)}`.slice(0, 30)
          XLSX.utils.book_append_sheet(wb, ws, name)
        }
      }
    }

    // ── NCR: one sheet per turnaround, add-on combo columns ────────────────
    else if (productCfg.mode === 'ncr') {
      const allowedAddons = productCfg.allowed_addons || []
      const addonDefs = allowedAddons
        .map(k => ({ key: k, def: config.globals.addons[k] }))
        .filter(a => a.def)
      const combos = [[]]
      for (const a of addonDefs) {
        const len = combos.length
        for (let i = 0; i < len; i++) combos.push([...combos[i], a])
      }
      const comboLabel = combo =>
        combo.length === 0 ? 'Base' : combo.map(a => a.def.label).join(' + ')
      const addonCostFor = (combo, qty) => {
        let total = 0
        for (const a of combo) {
          if (a.def.type === 'flat')             total += a.def.amount
          else if (a.def.type === 'flat_per_pc') total += a.def.amount * qty
        }
        return total
      }
      const markupMul = 1 + markup / 100
      const variantLabel = k => {
        const v = (productCfg.options?.variant || []).find(x => (typeof x === 'object' ? x.key : x) === k)
        return v && typeof v === 'object' ? v.label : k
      }

      const rowsArr = generateAllCombosMulti({ product, markup })
      for (const tn of turnarounds) {
        const tnMul = config.globals.turnaround[tn]?.multiplier ?? 1
        const header = ['Product Name', 'Size', 'Variant', 'Qty', ...combos.map(comboLabel)]
        const aoa = [header]
        const sorted = [...rowsArr].sort((a, b) =>
          String(a.specs.size).localeCompare(String(b.specs.size)) ||
          String(a.specs.variant).localeCompare(String(b.specs.variant)) ||
          a.qty - b.qty)
        for (const r of sorted) {
          const basePrice = r.byTurnaround?.[tn]?.sellPrice
          if (basePrice == null) continue
          const baseSubtotal = basePrice / tnMul / markupMul
          const row = [productCfg.label, r.specs.size, variantLabel(r.specs.variant), r.qty]
          for (const combo of combos) {
            const delta = addonCostFor(combo, r.qty)
            const newSell = (baseSubtotal + delta) * tnMul * markupMul
            row.push(Math.round(newSell * 100) / 100)
          }
          aoa.push(row)
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa)
        XLSX.utils.book_append_sheet(wb, ws, tnLabel(tn).slice(0, 30))
      }
    }

    // ── Default: flat lookup table ─────────────────────────────────────────
    else {
      let rowsArr = generateAllCombosMulti({ product, markup, sides })
      if (size) rowsArr = rowsArr.filter(r => r.specs.size === size)
      const otherKeys = productCfg.lookup_keys
        ? productCfg.lookup_keys.filter(k => k !== 'size')
        : []
      const labelOf = (key, value) => {
        const opt = (productCfg.options?.[key] || []).find(o => (typeof o === 'object' ? o.key : o) === value)
        return opt && typeof opt === 'object' ? opt.label : value
      }
      const finLabel = k => config.globals.finishings[k]?.label || k

      const data = rowsArr.map(r => {
        const row = { 'Product Name': productCfg.label, Size: r.specs.size }
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

      data.sort((a, b) =>
        String(a.Size).localeCompare(String(b.Size)) ||
        otherKeys.reduce((acc, k) => acc || String(a[k] ?? '').localeCompare(String(b[k] ?? '')), 0) ||
        a.Qty - b.Qty ||
        String(a.Finishing).localeCompare(String(b.Finishing))
      )

      const ws = XLSX.utils.json_to_sheet(data)
      XLSX.utils.book_append_sheet(wb, ws, productCfg.label.slice(0, 30) || 'Prices')
    }

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
