const express     = require('express')
const compression = require('compression')
const crypto      = require('crypto')
const fs          = require('fs')
const path        = require('path')
const XLSX        = require('xlsx')
const { calculatePrice, buildPriceTable, generateAllCombos, generateAllCombosMulti, loadConfig } = require('./engine')
const { calculateLargeFormat, loadLargeFormatConfig } = require('./engine-largeformat')

const LF_CONFIG_PATH = path.join(__dirname, 'config-largeformat.json')

const BACKUP_DIR  = path.join(__dirname, 'backups')
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR)

const app  = express()
const PORT = process.env.PORT || 3000

app.use(compression())
app.use(express.json({ limit: '10mb' }))
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

// GET /api/health — lightweight liveness check used by deploy.sh after restart.
app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

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
  // Snapshot the Large Format config alongside the main one so restores are
  // coherent. Older backups that lack this field still restore cleanly.
  let lfConfigData = null
  if (fs.existsSync(LF_CONFIG_PATH)) {
    lfConfigData = fs.readFileSync(LF_CONFIG_PATH, 'utf8')
  }
  const backupPath = path.join(BACKUP_DIR, `${id}.json`)
  const payload = { meta, config: JSON.parse(configData) }
  if (lfConfigData) payload.largeFormatConfig = JSON.parse(lfConfigData)
  fs.writeFileSync(backupPath, JSON.stringify(payload, null, 2))
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

// POST /api/restore/:id — restore config from a backup UUID. With no body,
// performs a full restore (legacy behavior). With { paths: ["products.flyer",
// "globals.addons.grommet", "largeFormat.products.banner.materials", ...] },
// only those subtrees are copied from the backup over the current config.
app.post('/api/restore/:id', (req, res) => {
  try {
    const backupPath = path.join(BACKUP_DIR, `${req.params.id}.json`)
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' })
    createBackup('Before restore')
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter(p => typeof p === 'string' && p.length) : null

    if (paths && paths.length) {
      const current   = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
      const currentLf = fs.existsSync(LF_CONFIG_PATH)
        ? JSON.parse(fs.readFileSync(LF_CONFIG_PATH, 'utf8'))
        : null
      const { newConfig, newLf, lfTouched } = applySelectiveRestore(current, currentLf, backup, paths)
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(newConfig, null, 2))
      if (lfTouched && newLf) fs.writeFileSync(LF_CONFIG_PATH, JSON.stringify(newLf, null, 2))
      return res.json({ ok: true, restored: backup.meta, mode: 'selective', appliedPaths: paths })
    }

    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(backup.config, null, 2))
    if (backup.largeFormatConfig) {
      fs.writeFileSync(LF_CONFIG_PATH, JSON.stringify(backup.largeFormatConfig, null, 2))
    }
    res.json({ ok: true, restored: backup.meta, mode: 'full' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Selective-restore helpers ────────────────────────────────────────────────

// Copy each `paths[i]` from the backup into a clone of the current config.
// Paths starting with "largeFormat." target the LF config; everything else
// targets the main config. If the backup has no LF snapshot, LF paths are
// silently skipped (mirrors full-restore semantics: no LF in backup → no LF
// write). When the backup's value at a path is undefined, the key is
// deleted from current — this is how "remove this product" round-trips.
function applySelectiveRestore(currentConfig, currentLf, backup, paths) {
  const newConfig = JSON.parse(JSON.stringify(currentConfig))
  let newLf = currentLf ? JSON.parse(JSON.stringify(currentLf)) : null
  let lfTouched = false
  const LF_PREFIX = 'largeFormat.'
  for (const p of paths) {
    if (p.startsWith(LF_PREFIX)) {
      if (!backup.largeFormatConfig) continue
      newLf = newLf || {}
      const sub = p.slice(LF_PREFIX.length)
      setAtPath(newLf, sub, getAtPath(backup.largeFormatConfig, sub))
      lfTouched = true
    } else if (p === 'largeFormat') {
      if (!backup.largeFormatConfig) continue
      newLf = JSON.parse(JSON.stringify(backup.largeFormatConfig))
      lfTouched = true
    } else {
      setAtPath(newConfig, p, getAtPath(backup.config, p))
    }
  }
  return { newConfig, newLf, lfTouched }
}

// 'products.flyer.price_table[0].prices.25' → ['products','flyer','price_table',0,'prices','25']
// Numeric segments inside [...] become numbers so we can index arrays.
function parsePath(path) {
  const parts = []
  for (const seg of path.split('.')) {
    const m = seg.match(/^([^[]*)((?:\[\d+\])*)$/)
    if (!m) { parts.push(seg); continue }
    if (m[1]) parts.push(m[1])
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) parts.push(Number(idx[1]))
  }
  return parts
}

function getAtPath(obj, path) {
  let cur = obj
  for (const seg of parsePath(path)) {
    if (cur == null) return undefined
    cur = cur[seg]
  }
  return cur
}

// Sets `obj[path] = value`. Auto-creates intermediate containers
// (object or array based on the next segment's type). If `value` is
// undefined, deletes the key (or splices the array element).
function setAtPath(obj, path, value) {
  const parts = parsePath(path)
  if (!parts.length) return
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const seg  = parts[i]
    const next = parts[i + 1]
    if (cur[seg] == null) cur[seg] = typeof next === 'number' ? [] : {}
    cur = cur[seg]
  }
  const last = parts[parts.length - 1]
  if (value === undefined) {
    if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1)
    else delete cur[last]
  } else {
    cur[last] = value
  }
}

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

// GET /api/backup/:id/diff — preview what a restore would change. Returns
// one group per logical section (globals.*, each product, each LF product)
// with a status (changed/added/removed/unchanged), a leaf-change count, and
// up to 10 sample diffs so the UI can render an at-a-glance preview.
app.get('/api/backup/:id/diff', (req, res) => {
  try {
    const backupPath = path.join(BACKUP_DIR, `${req.params.id}.json`)
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' })
    const backup    = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    const current   = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
    const currentLf = fs.existsSync(LF_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(LF_CONFIG_PATH, 'utf8'))
      : null
    res.json({
      meta: backup.meta,
      groups: buildDiffGroups(current, backup.config, currentLf, backup.largeFormatConfig || null),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

function buildDiffGroups(curConfig, bakConfig, curLf, bakLf) {
  const groups = []
  for (const sub of ['turnaround', 'addons', 'finishings']) {
    groups.push(makeDiffGroup(
      `globals.${sub}`, `Globals → ${sub}`,
      curConfig.globals?.[sub], bakConfig.globals?.[sub]
    ))
  }
  const prodKeys = new Set([
    ...Object.keys(curConfig.products || {}),
    ...Object.keys(bakConfig.products || {}),
  ])
  for (const k of [...prodKeys].sort()) {
    const cur = curConfig.products?.[k]
    const bak = bakConfig.products?.[k]
    const label = bak?.label || cur?.label || k
    groups.push(makeDiffGroup(`products.${k}`, `Product → ${label}`, cur, bak))
  }
  // Restore only writes the LF file when the backup contains one. If it
  // doesn't, surface that so the user knows current LF won't be touched.
  if (bakLf) {
    const lfKeys = new Set([
      ...Object.keys(curLf?.products || {}),
      ...Object.keys(bakLf.products || {}),
    ])
    for (const k of [...lfKeys].sort()) {
      const cur = curLf?.products?.[k]
      const bak = bakLf.products?.[k]
      const label = bak?.label || cur?.label || k
      groups.push(makeDiffGroup(`largeFormat.products.${k}`, `Large Format → ${label}`, cur, bak))
    }
  } else {
    groups.push({
      path: 'largeFormat', label: 'Large Format',
      status: 'skipped', changeCount: 0, samples: [],
      note: 'This backup pre-dates Large Format snapshots — restore will leave the current Large Format config untouched.',
    })
  }
  return groups
}

// Cap leaves per group so a 4000-cell price-table diff doesn't bloat the
// response. Above this, the UI offers group-level restore only.
const MAX_LEAVES_PER_GROUP = 500
function makeDiffGroup(path, label, current, backup) {
  if (backup === undefined && current === undefined)
    return { path, label, status: 'unchanged', changeCount: 0, leaves: [], truncated: false }
  if (backup === undefined)
    return { path, label, status: 'removed', changeCount: countLeaves(current), leaves: [], truncated: false }
  if (current === undefined)
    return { path, label, status: 'added', changeCount: countLeaves(backup), leaves: [], truncated: false }
  if (deepEqual(current, backup))
    return { path, label, status: 'unchanged', changeCount: 0, leaves: [], truncated: false }
  const all = collectLeafDiffs(current, backup)
  return {
    path, label, status: 'changed',
    changeCount: all.length,
    leaves: all.slice(0, MAX_LEAVES_PER_GROUP),
    truncated: all.length > MAX_LEAVES_PER_GROUP,
  }
}

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

function countLeaves(v) {
  if (v === null || typeof v !== 'object') return 1
  if (Array.isArray(v)) return v.reduce((n, x) => n + countLeaves(x), 0) || 1
  let n = 0
  for (const k of Object.keys(v)) n += countLeaves(v[k])
  return n
}

// Walks both objects and emits a flat list of leaf-level differences.
// Arrays recurse element-wise so a single-cell change in price_table doesn't
// collapse into one opaque "array changed" entry.
function collectLeafDiffs(cur, bak, prefix = '') {
  const out = []
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
  if (isObj(cur) && isObj(bak)) {
    const keys = new Set([...Object.keys(cur), ...Object.keys(bak)])
    for (const k of keys) {
      out.push(...collectLeafDiffs(cur[k], bak[k], prefix ? `${prefix}.${k}` : k))
    }
    return out
  }
  if (Array.isArray(cur) && Array.isArray(bak)) {
    const len = Math.max(cur.length, bak.length)
    for (let i = 0; i < len; i++) {
      out.push(...collectLeafDiffs(cur[i], bak[i], `${prefix}[${i}]`))
    }
    return out
  }
  if (deepEqual(cur, bak)) return out
  let kind = 'changed'
  if (cur === undefined) kind = 'added'
  else if (bak === undefined) kind = 'removed'
  out.push({ path: prefix, kind, from: cur, to: bak })
  return out
}

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

      // Add-on columns mirror the on-screen Price Table: one Line/Unit pair per
      // add-on under each turnaround. `double_sided` is a normal add-on column now
      // that the Sides dropdown is gone and the base is never auto-upgraded.
      const addonDefs = (productCfg.allowed_addons || [])
        .filter(k => config.globals.addons[k])
        .map(k => ({ key: k, def: config.globals.addons[k] }))
      const markupMul = 1 + markup / 100
      const addonDelta = (def, qty, baseCost) => {
        if (def.type === 'flat')        return def.amount
        if (def.type === 'flat_per_pc') return def.amount * qty
        if (def.type === 'pct_of_base') return (baseCost || 0) * (def.amount / 100)
        return 0
      }
      const round2 = n => Math.round(n * 100) / 100

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
          const tnMul = config.globals.turnaround[tn]?.multiplier ?? 1
          for (const a of addonDefs) {
            if (p) {
              const sell = p.sellPrice + addonDelta(a.def, r.qty, r.baseCost) * tnMul * markupMul
              row[`${tnLabel(tn)} +${a.def.label} (Line $)`] = round2(sell)
              row[`${tnLabel(tn)} +${a.def.label} ($/u)`]    = round2(sell / r.qty)
            } else {
              row[`${tnLabel(tn)} +${a.def.label} (Line $)`] = ''
              row[`${tnLabel(tn)} +${a.def.label} ($/u)`]    = ''
            }
          }
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
    const safeName = `${productCfg.label}${size ? '-' + size : ''}.xlsx`
      .replace(/[^a-z0-9.-]+/gi, '_')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
    res.send(buf)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ── Large Format endpoints ───────────────────────────────────────────────────

// GET — return the parsed config-largeformat.json
app.get('/api/largeformat-config', (req, res) => {
  try {
    res.json(loadLargeFormatConfig())
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PUT — save the whole Large Format config. Auto-backup (of both configs)
// happens first via createBackup.
app.put('/api/largeformat-config', (req, res) => {
  try {
    createBackup('Before LF save')
    fs.writeFileSync(LF_CONFIG_PATH, JSON.stringify(req.body, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST — single Large Format price calculation
app.post('/api/largeformat-calculate', (req, res) => {
  try {
    res.json(calculateLargeFormat(req.body))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST — return the price matrix as JSON so the client can render an HTML
// preview before downloading. Same shape used by the xlsx export.
// Body: { product, material? (optional — omit for all materials), markup? }
// Returns: [{ material, materialLabel, qtys, turnarounds:[{key,label}], rows:[{ size, width, height, sqft, prices:{ tn:{ qty:price } } }] }]
app.post('/api/largeformat-preview', (req, res) => {
  try {
    const { product, material, markup = 0 } = req.body || {}
    const lf = loadLargeFormatConfig()
    const mainConfig = loadConfig()
    const productCfg = lf.products?.[product]
    if (!productCfg) return res.status(400).json({ error: `Unknown Large Format product: ${product}` })

    const allMaterials = productCfg.materials || []
    const materials = material
      ? allMaterials.filter(m => m.material_name === material)
      : allMaterials
    if (!materials.length) return res.status(400).json({ error: 'No materials' })

    const sizes = productCfg.sizes || []
    const allTns = Object.keys(mainConfig.globals?.turnaround || {})
    const tns = (productCfg.allowed_turnarounds && productCfg.allowed_turnarounds.length)
      ? productCfg.allowed_turnarounds
      : allTns
    const turnarounds = tns.map(k => ({ key: k, label: mainConfig.globals.turnaround[k]?.label || k }))
    const QTY_BREAKS = (Array.isArray(productCfg.quantities) && productCfg.quantities.length)
      ? productCfg.quantities.slice().sort((a, b) => a - b)
      : [1, 2, 5, 10, 25, 50, 100, 250, 500]
    // One variant per allowed add-on (plus a Base row). Single-addon rows
    // — not all 2^N combinations — so the table stays scannable.
    const allowedAddons = (productCfg.allowed_addons || [])
      .filter(k => mainConfig.globals?.addons?.[k])
    const variants = [{ label: 'Base', addons: [] }]
    for (const k of allowedAddons) {
      variants.push({ label: '+ ' + (mainConfig.globals.addons[k].label || k), addons: [k], addonKey: k })
    }
    const hasVariants = allowedAddons.length > 0

    const buildPriceRow = (sz, m, addons) => {
      const prices = {}
      for (const tn of tns) {
        prices[tn] = {}
        for (const q of QTY_BREAKS) {
          try {
            const r = calculateLargeFormat({
              product, sizeName: sz.sizeName, materialName: m.material_name,
              qty: q, turnaround: tn, markup, addons,
            })
            prices[tn][q] = r.sellPrice
          } catch { prices[tn][q] = null }
        }
      }
      return prices
    }

    const out = []
    for (const m of materials) {
      const rows = []
      for (const sz of sizes) {
        const perPiece = (Number(sz.width) * Number(sz.height)) / 144
        for (const v of variants) {
          rows.push({
            size: sz.sizeName, width: sz.width, height: sz.height,
            sqft: Math.round(perPiece * 100) / 100,
            variant: v.label,
            isBase: v.addons.length === 0,
            prices: buildPriceRow(sz, m, v.addons),
          })
        }
      }
      out.push({
        material: m.material_name,
        materialLabel: m.label || m.material_name,
        qtys: QTY_BREAKS,
        turnarounds,
        hasVariants,
        variants: variants.map(v => v.label),
        rows,
      })
    }
    res.json({ product, productLabel: productCfg.label || product, materials: out })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST — export a Large Format product's pricing as .xlsx.
// Body: { product, material? (optional — omit for "all materials"), markup? }
// Layout: one sheet per material. Rows = sizes; columns = qty break points
// (1, 2, 5, 10, 25, 50, 100, 250, 500), one block of columns per allowed
// turnaround. Cells show sellPrice. Header rows label turnaround × qty.
app.post('/api/largeformat-export-xlsx', (req, res) => {
  try {
    const { product, material, markup = 0 } = req.body || {}
    const lf = loadLargeFormatConfig()
    const mainConfig = loadConfig()
    const productCfg = lf.products?.[product]
    if (!productCfg) return res.status(400).json({ error: `Unknown Large Format product: ${product}` })

    const allMaterials = productCfg.materials || []
    const materials = material
      ? allMaterials.filter(m => m.material_name === material)
      : allMaterials
    if (!materials.length) return res.status(400).json({ error: 'No materials to export' })

    const sizes = productCfg.sizes || []
    if (!sizes.length) return res.status(400).json({ error: 'Product has no sizes' })

    const allTns = Object.keys(mainConfig.globals?.turnaround || {})
    const tns = (productCfg.allowed_turnarounds && productCfg.allowed_turnarounds.length)
      ? productCfg.allowed_turnarounds
      : allTns
    const tnLabel = k => mainConfig.globals.turnaround[k]?.label || k

    const QTY_BREAKS = (Array.isArray(productCfg.quantities) && productCfg.quantities.length)
      ? productCfg.quantities.slice().sort((a, b) => a - b)
      : [1, 2, 5, 10, 25, 50, 100, 250, 500]
    // One variant per allowed add-on (plus a Base row). Single-addon rows.
    const allowedAddons = (productCfg.allowed_addons || [])
      .filter(k => mainConfig.globals?.addons?.[k])
    const variantSpecs = [{ label: 'Base', addons: [] }]
    for (const k of allowedAddons) {
      variantSpecs.push({ label: '+ ' + (mainConfig.globals.addons[k].label || k), addons: [k] })
    }
    const hasVariants = allowedAddons.length > 0
    const wb = XLSX.utils.book_new()

    for (const m of materials) {
      // Two header rows: turnaround spans, then qty columns underneath.
      const baseCols = ['Size', 'Width (in)', 'Height (in)', 'sqft / piece']
      if (hasVariants) baseCols.push('Variant')
      const topHeader = [...baseCols]
      const subHeader = baseCols.map(() => '')
      for (const tn of tns) {
        topHeader.push(tnLabel(tn))
        for (let i = 1; i < QTY_BREAKS.length; i++) topHeader.push('')
        for (const q of QTY_BREAKS) subHeader.push(`Qty ${q}`)
      }
      const aoa = [topHeader, subHeader]

      for (const sz of sizes) {
        const perPiece = (Number(sz.width) * Number(sz.height)) / 144
        for (const v of variantSpecs) {
          const row = [sz.sizeName, sz.width, sz.height, Math.round(perPiece * 100) / 100]
          if (hasVariants) row.push(v.label)
          for (const tn of tns) {
            for (const q of QTY_BREAKS) {
              try {
                const r = calculateLargeFormat({
                  product, sizeName: sz.sizeName, materialName: m.material_name,
                  qty: q, turnaround: tn, markup, addons: v.addons,
                })
                row.push(r.sellPrice)
              } catch {
                row.push('')
              }
            }
          }
          aoa.push(row)
        }
      }

      const ws = XLSX.utils.aoa_to_sheet(aoa)
      // Merge each turnaround's label across its qty columns
      ws['!merges'] = ws['!merges'] || []
      let col = baseCols.length
      for (let i = 0; i < tns.length; i++) {
        ws['!merges'].push({ s: { r: 0, c: col }, e: { r: 0, c: col + QTY_BREAKS.length - 1 } })
        col += QTY_BREAKS.length
      }
      const sheetName = (m.label || m.material_name).slice(0, 30) || 'Sheet'
      XLSX.utils.book_append_sheet(wb, ws, sheetName)
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const tag = material || 'all-materials'
    const safeName = `${productCfg.label}-${tag}.xlsx`.replace(/[^a-z0-9.-]+/gi, '_')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
    res.send(buf)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ── Large Format → Storefront import format ──────────────────────────────────
// Build the 8-sheet payload that matches import_product.xlsx (the storefront
// platform's product import template). Each material in the LF config becomes
// its own product (the storefront has no "material" concept).
//
// Pricing model: "Size based Price (Dynamic Size)" — Total = area × pricePerSqft × qty.
// PRODUCT_PRICE rows therefore encode sqft tiers (qty/qty_to = sqft range,
// price = ratePerSqft × markup). The labels say "qty" but the storefront UI
// renders them as "Size From/To (Inch)" — confirmed against printshop import.
function buildStorefrontPayload({ markup = 0, category = 'Large Format', product = null } = {}) {
  const lf = loadLargeFormatConfig()
  const mainConfig = loadConfig()
  const allProducts = lf.products || {}
  const products = product
    ? (allProducts[product] ? { [product]: allProducts[product] } : {})
    : allProducts

  const categoryRows = [
    { category_name: category, category_internal_name: '', category_url: '',
      sort_order: 1, status: 'Active' },
  ]

  const detailRows = []
  const sizeRows   = []
  const priceRows  = []
  const galleryRows = []
  const optionGroupRows = []
  const optionRows = []
  const optionAttributeRows = []

  // Add-ons group only — Turnaround is set up natively in OnPrintShop because
  // its multipliers (e.g. Next Day +20%) are percentages, which OnPrintShop's
  // import schema doesn't model.
  optionGroupRows.push(
    { opt_group_name: 'Add-ons', sort_order: 1, use_for: 'Both', is_collapse: 'no' },
  )

  let sortOrder = 1
  for (const [lfKey, lfProd] of Object.entries(products)) {
    const materials = lfProd.materials || []
    const sizes     = lfProd.sizes     || []
    const productMarkup = markup || lfProd.markup || 0
    const markupMul = 1 + productMarkup / 100

    for (const m of materials) {
      const title = m.label || m.material_name
      detailRows.push({
        product_category:                category,
        products_title:                  title,
        products_internal_title:         lfKey,
        product_url:                     '',
        small_image:                     '',
        large_image:                     '',
        product_keywords:                '',
        product_description:             '',
        long_description:                '',
        upload_description:              '',
        browse_description:              '',
        price_defining_method:           'Size based Price (Dynamic Size)',
        page_title:                      '',
        user_type_id:                    'All User',
        corporate_id:                    '',
        department_id:                   '',
        sort_order:                      sortOrder++,
        visible:                         'Active',
        product_type:                    '',
        products_draw_cutting_margins:   '',
        products_draw_area_margins:      '',
        default_zoom:                    '100',
        customsize_measurement_unit:     'Inch',
        size_visible:                    'Yes',
        sku_number:                      '',
        allow_free_shipping:             '',
      })

      let sizeOrder = 1
      for (const sz of sizes) {
        sizeRows.push({
          products_title:  title,
          size_title:      sz.sizeName,
          size_width:      sz.width,
          size_height:     sz.height,
          weight:          '',
          setup_cost:      '',
          fold_type:       '',
          fold_option:     '',
          fold_position:   '',
          orientation:     'Select Orientation',
          default_size:    sizeOrder === 1 ? 'yes' : 'no',
          sort_order:      sizeOrder++,
        })
      }

      // Sqft tiers from material.rates → emitted as sq-INCH tiers because
      // OnPrintShop's Dynamic Size formula is `(W × H) × price × qty` with
      // W and H entered in inches, so the matching unit is square inches.
      //   tier sqft → sq-in: multiply by 144
      //   ratePerSqft → ratePerSqIn: divide by 144
      // The "Size From / Size To (In Inch)" UI columns are then literally
      // square inches (e.g. 144 = 1 sqft), and the price per sq-in is what
      // gets multiplied by W × H. Rows are repeated per predefined size
      // because OnPrintShop matches by (products_title, size_title).
      const rates = (m.rates || [])
        .map(r => ({ sqft: Number(r.sqft), ratePerSqft: Number(r.ratePerSqft) }))
        .filter(r => !isNaN(r.sqft) && !isNaN(r.ratePerSqft))
        .sort((a, b) => a.sqft - b.sqft)

      for (const sz of sizes) {
        // Upper-bound tier semantics: tier with sqft=N covers (prev.sqft, N]
        // sqft → in sq-inches, (prev.sqft × 144, N × 144]. Last tier extends
        // to infinity. Per-sq-in sell price = ratePerSqft × markup ÷ 144.
        let prevSqft = 0
        for (let i = 0; i < rates.length; i++) {
          const tier = rates[i]
          const isLast = i === rates.length - 1
          const sqInFrom = i === 0 ? 1 : prevSqft * 144 + 1
          const sqInTo   = isLast ? 999999 : tier.sqft * 144
          const sellPerSqIn = Math.round(tier.ratePerSqft * markupMul / 144 * 10000) / 10000
          priceRows.push({
            products_title: title,
            size_title:     sz.sizeName,
            qty:            sqInFrom,
            qty_to:         sqInTo,
            price:          sellPerSqIn,
            user_type_id:   'All User',
            corporate_id:   '',
            vendor_price:   '',
          })
          prevSqft = tier.sqft
        }
      }

      galleryRows.push({
        products_title:            title,
        products_large_image_name: '',
        image_title:               '',
        sort_order:                '',
        status:                    'InActive',
      })

      // Add-on options: one Checkbox per allowed flat-per-piece addon.
      // Percentage-of-base addons (e.g. Two-Sided Printing +40%) are skipped
      // because OnPrintShop's import schema can't model multipliers cleanly.
      // Per-attribute prices also can't be imported (no price column on
      // PRODUCT_OPTION_ATTRIBUTES) — the amount is in the label as a hint,
      // and you set the actual price + pricing mode in OnPrintShop after
      // import. `price_calculate_type` is left blank because OnPrintShop
      // rejects guessed enum strings — you'll choose "Quantity Based Attr"
      // in the UI when entering the price.
      const allowedAddons = (lfProd.allowed_addons || [])
        .filter(k => mainConfig.globals?.addons?.[k])
        .filter(k => mainConfig.globals.addons[k].type === 'flat_per_pc')
      let addonSort = 1
      for (const k of allowedAddons) {
        const a = mainConfig.globals.addons[k]
        optionRows.push({
          products_title:        title,
          title:                 a.label || k,
          description:           '',
          options_type:          'Checkbox',
          apply_multiplication:  'yes',
          display_in_calculator: 'yes',
          hire_designer_option:  'no',
          required:              'no',
          display_above_size:    'no',
          sort_order:            addonSort++,
          status:                'Active',
          price_calculate_type:  '',
          opt_group_name:        'Add-ons',
          opt_export_group_name: '',
        })
        optionAttributeRows.push({
          products_title:    title,
          option_title:      a.label || k,
          label:             `${a.label || k} (+$${a.amount}/pc)`,
          default_attribute: 'no',
          sort_order:        1,
          status:            'Active',
        })
      }
    }
  }

  return {
    PRODUCT_CATEGORY:           { headers: ['category_name','category_internal_name','category_url','sort_order','status'], rows: categoryRows },
    PRODUCT_DETAILS:            { headers: ['product_category','products_title','products_internal_title','product_url','small_image','large_image','product_keywords','product_description','long_description','upload_description','browse_description','price_defining_method','page_title','user_type_id','corporate_id','department_id','sort_order','visible','product_type','products_draw_cutting_margins','products_draw_area_margins','default_zoom','customsize_measurement_unit','size_visible','sku_number','allow_free_shipping'], rows: detailRows },
    PRODUCT_SIZES:              { headers: ['products_title','size_title','size_width','size_height','weight','setup_cost','fold_type','fold_option','fold_position','orientation','default_size','sort_order'], rows: sizeRows },
    PRODUCT_PRICE:              { headers: ['products_title','size_title','qty','qty_to','price','user_type_id','corporate_id','vendor_price'], rows: priceRows },
    PRODUCT_GALLERY:            { headers: ['products_title','products_large_image_name','image_title','sort_order','status'], rows: galleryRows },
    PRODUCT_OPTION_GROUP:       { headers: ['opt_group_name','sort_order','use_for','is_collapse'], rows: optionGroupRows },
    PRODUCT_OPTION:             { headers: ['products_title','title','description','options_type','apply_multiplication','display_in_calculator','hire_designer_option','required','display_above_size','sort_order','status','price_calculate_type','opt_group_name','opt_export_group_name'], rows: optionRows },
    PRODUCT_OPTION_ATTRIBUTES:  { headers: ['products_title','option_title','label','default_attribute','sort_order','status'], rows: optionAttributeRows },
  }
}

// GET — preview the storefront-import payload as JSON (used by the UI)
app.get('/api/largeformat-storefront-preview', (req, res) => {
  try {
    const markup   = Number(req.query.markup) || 0
    const category = (req.query.category || 'Large Format').toString()
    const product  = req.query.product ? req.query.product.toString() : null
    res.json(buildStorefrontPayload({ markup, category, product }))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET — download the storefront-import .xlsx
app.get('/api/largeformat-storefront-export', (req, res) => {
  try {
    const markup   = Number(req.query.markup) || 0
    const category = (req.query.category || 'Large Format').toString()
    const product  = req.query.product ? req.query.product.toString() : null
    const payload = buildStorefrontPayload({ markup, category, product })

    const wb = XLSX.utils.book_new()
    for (const [sheetName, { headers, rows }] of Object.entries(payload)) {
      const aoa = [headers, ...rows.map(r => headers.map(h => r[h] ?? ''))]
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      XLSX.utils.book_append_sheet(wb, ws, sheetName)
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const tag = product ? product : 'all'
    const safeName = `largeformat-storefront-${tag}.xlsx`.replace(/[^a-z0-9.-]+/gi, '_')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
    res.send(buf)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`Pricing engine running at http://localhost:${PORT}`)
})
