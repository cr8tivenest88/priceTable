// ── State ─────────────────────────────────────────────────────────────────────
let config = {}
let currentProdKey = null

// Canonical default options for products that have a fixed domain.
// Used to offer "restore missing defaults" when the user accidentally deletes one.
const DEFAULT_OPTIONS = {
  coroplast: {
    variant: [
      { key: '1_side',        label: '1 Side' },
      { key: '2_sides',       label: '2 Sides' },
      { key: 'grommet_top_2', label: 'Grommets — Top 2 Corners' },
      { key: 'grommet_all_4', label: 'Grommets — All 4 Corners' },
      { key: 'h_stand',       label: 'H Stand' },
    ],
    thickness: ['4mm', '6mm', '8mm', '10mm'],
  },
  foamcore: {
    variant: [
      { key: '1_side',        label: '1 Side' },
      { key: '2_sides',       label: '2 Sides' },
      { key: 'grommet_top_2', label: 'Grommets — Top 2 Corners' },
      { key: 'grommet_all_4', label: 'Grommets — All 4 Corners' },
    ],
    thickness: ['4mm', '6mm', '8mm'],
  },
}

// Products that render with the pivoted variant-column layout (one mini-table
// per turnaround per size, variants as columns, thickness × qty as rows).
function isPivotVariantProduct(prod) {
  return prod && (prod.lookup_keys || []).join(',') === 'thickness,size,variant'
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  config = await api('GET', '/api/config')
  initNav()
  initPriceTable()
  initPrices()
  initProducts()
  initFinishings()
  initGlobals()
  initBackups()
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(url, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

async function saveConfig() {
  await api('PUT', '/api/config', config)
  toast('Saved')
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
    })
  })
  document.getElementById('reload-btn')?.addEventListener('click', hardReload)
}

async function hardReload() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
    }
  } catch {}
  window.location.href = window.location.pathname + '?v=' + Date.now()
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.style.background = type === 'err' ? '#ef4444' : '#1e293b'
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 2500)
}

function populateSelect(sel, items) {
  sel.innerHTML = ''
  for (const item of items) {
    const o = document.createElement('option')
    o.value = item.value
    o.textContent = item.label
    sel.appendChild(o)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE TABLE TAB — pick product → pick size → generate all combos for that size
// ─────────────────────────────────────────────────────────────────────────────
function initPriceTable() {
  const productSel = document.getElementById('pt-product')
  populateSelect(productSel, Object.entries(config.products).map(([k, v]) => ({ value: k, label: v.label })))
  productSel.addEventListener('change', onProductChange)
  document.getElementById('pt-generate').addEventListener('click', generate)
  document.getElementById('pt-export').addEventListener('click', exportXlsx)
  onProductChange()
}

async function exportXlsx() {
  const key  = document.getElementById('pt-product').value
  const prod = config.products[key]
  const markup = parseFloat(document.getElementById('pt-markup').value) || 0
  const sides  = parseInt(document.getElementById('pt-sides').value) || 1
  const size = document.getElementById('pt-size').value
  const expBtn = document.getElementById('pt-export')
  expBtn.disabled = true
  expBtn.textContent = 'Exporting…'
  try {
    const res = await fetch('/api/export-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: key, size, sides, markup }),
    })
    if (!res.ok) throw new Error((await res.json()).error || res.statusText)
    const blob = await res.blob()
    const url  = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${prod.label}-${size}-${sides}sided.xlsx`.replace(/[^a-z0-9.-]+/gi, '_')
    document.body.appendChild(a); a.click()
    a.remove(); URL.revokeObjectURL(url)
    toast('Downloaded')
  } catch (e) {
    toast(e.message, 'err')
  } finally {
    expBtn.disabled = false
    expBtn.textContent = '⬇ Export to Excel'
  }
}

function onProductChange() {
  const key = document.getElementById('pt-product').value
  const prod = config.products[key]
  const sizes = (prod.options && prod.options.size) || uniqueKeyValues(prod, 'size')
  populateSelect(document.getElementById('pt-size'), sizes.map(s => ({ value: s, label: s })))
  document.getElementById('pt-size-field').style.display = ''

  // Show thickness dropdown only if the product has a `thickness` lookup key.
  // Adds an "All" option so the user can still see the full table.
  const thickField = document.getElementById('pt-thickness-field')
  const hasThickness = (prod.lookup_keys || []).includes('thickness')
  if (hasThickness) {
    const thicknesses = prod.options?.thickness || []
    populateSelect(document.getElementById('pt-thickness'),
      [{ value: '', label: 'All thicknesses' }, ...thicknesses.map(t => ({ value: t, label: t }))])
    thickField.style.display = ''
  } else {
    thickField.style.display = 'none'
  }

  const allowedTn = allowedTurnaroundsFor(prod)
  const comboCount = prod.price_table?.length || (prod.mode === 'ncr' ? sizes.length * (prod.options?.variant?.length || 0) : 0)
  document.getElementById('pt-info').textContent = `${sizes.length} sizes · ${comboCount} combo rows · ${allowedTn.length} turnaround${allowedTn.length === 1 ? '' : 's'}`
}

function allowedTurnaroundsFor(prod) {
  // Explicit array (even empty) is authoritative. Undefined = legacy default to all.
  return Array.isArray(prod.allowed_turnarounds)
    ? prod.allowed_turnarounds
    : Object.keys(config.globals.turnaround)
}
function allowedFinishingsFor(prod) {
  return Array.isArray(prod.allowed_finishings)
    ? prod.allowed_finishings
    : Object.keys(config.globals.finishings)
}

function uniqueKeyValues(prod, key) {
  const set = new Set()
  for (const r of (prod.price_table || [])) if (r.key[key] != null) set.add(r.key[key])
  return [...set]
}

async function generate() {
  const key = document.getElementById('pt-product').value
  const prod = config.products[key]
  const markup = parseFloat(document.getElementById('pt-markup').value) || 0
  const sides  = parseInt(document.getElementById('pt-sides').value) || 1
  const result = document.getElementById('pt-result')
  const genBtn = document.getElementById('pt-generate')
  const expBtn = document.getElementById('pt-export')

  // Show loader and disable buttons during generation
  result.innerHTML = `<div class="loader"><div class="spinner"></div><span>Generating price table…</span></div>`
  genBtn.disabled = true
  expBtn.disabled = true
  genBtn.textContent = 'Generating…'

  try {
    const size = document.getElementById('pt-size').value
    const thickness = document.getElementById('pt-thickness')?.value || ''
    const turnarounds = allowedTurnaroundsFor(prod)

    // Single server call — engine returns rows with a byTurnaround map already populated
    const all = await api('POST', '/api/all-combos-multi', { product: key, markup, sides })
    let merged = all.filter(r => r.specs.size === size)
    if (thickness) merged = merged.filter(r => r.specs.thickness === thickness)

    result.innerHTML = renderTable(prod, merged, size, markup, sides, turnarounds)
  } catch (e) {
    result.innerHTML = `<p style="color:var(--danger);padding:16px">${e.message}</p>`
  } finally {
    genBtn.disabled = false
    expBtn.disabled = false
    genBtn.textContent = 'Generate'
  }
}

function renderTable(prod, rows, size, markup, sides, turnarounds) {
  // Coroplast / Foamcore share a pivoted layout: variant becomes columns, one
  // mini table per turnaround.
  if (isPivotVariantProduct(prod)) {
    return renderCoroplastPriceTable(prod, rows, size, markup, sides, turnarounds)
  }

  // NCR gets its own layout too: no finishing column, add-on combo columns
  if (prod.mode === 'ncr') {
    return renderNcrPriceTable(prod, rows, size, markup, turnarounds)
  }

  // For lookup products, lookup_keys describes the row dimensions. For NCR
  // (mode: ncr), the row dimension is just `variant`.
  const otherKeys = prod.lookup_keys
    ? prod.lookup_keys.filter(k => k !== 'size')
    : (prod.mode === 'ncr' ? ['variant'] : [])

  // No rows means this size has no prices entered yet. Render the empty
  // structure (combos × qtys × finishings) with placeholder cells so the user
  // can see what needs filling in.
  if (!rows.length) {
    return renderEmptyStructure(prod, otherKeys, size, markup, sides, turnarounds)
  }

  // Sort: combo → qty → finishing
  rows.sort((a, b) => {
    const ak = otherKeys.map(k => formatKeyValue(prod, k, a.specs[k])).join(' · ')
    const bk = otherKeys.map(k => formatKeyValue(prod, k, b.specs[k])).join(' · ')
    return ak.localeCompare(bk) || a.qty - b.qty || String(a.finishing).localeCompare(String(b.finishing))
  })

  let html = `<h2 style="margin:20px 0 10px;font-size:18px">
    ${prod.label} — ${size}
    <span style="color:var(--muted);font-size:12px;font-weight:400">${sides}-sided · ${markup}% markup</span>
  </h2>`

  html += `<div class="card" style="padding:0;overflow:hidden"><div class="price-table-wrap"><table>
    <thead><tr>
      <th>Product Name</th>
      <th>Size</th>
      ${otherKeys.map(k => `<th>${humanize(k)}</th>`).join('')}
      <th>Qty</th>
      <th>Finishing</th>
      ${turnarounds.map(tn => `<th>${config.globals.turnaround[tn]?.label || tn}</th>`).join('')}
    </tr></thead>
    <tbody>`

  for (const r of rows) {
    html += `<tr>
      <td>${prod.label}</td>
      <td>${r.specs.size}</td>
      ${otherKeys.map(k => `<td>${formatKeyValue(prod, k, r.specs[k])}</td>`).join('')}
      <td><strong>${r.qty}</strong></td>
      <td>${config.globals.finishings[r.finishing]?.label || r.finishing}</td>
      ${turnarounds.map(tn => {
        const p = r.byTurnaround?.[tn]
        return p
          ? `<td><span class="sell">$${p.sellPrice}</span><br><span class="unit">$${p.unitSellPrice}/u</span></td>`
          : `<td>—</td>`
      }).join('')}
    </tr>`
  }

  html += `</tbody></table></div></div>`
  return html
}

// Coroplast-specific price table: variant becomes columns, one mini table per turnaround
function renderCoroplastPriceTable(prod, rows, size, markup, sides, turnarounds) {
  if (!rows.length) {
    return `<h2 style="margin:20px 0 10px;font-size:18px">${prod.label} — ${size}</h2>
      <p style="color:var(--muted);padding:16px">No prices for this size. Fill them in under the Prices tab.</p>`
  }

  const variants = prod.options?.variant || []
  const varKey   = v => typeof v === 'object' ? v.key : v
  const varLabel = v => typeof v === 'object' ? v.label : v
  const finLabel = k => config.globals.finishings[k]?.label || k
  const tnLabel  = k => config.globals.turnaround[k]?.label || k

  // Build lookup: map[turnaround][thickness][finishing][qty][variant] = {sellPrice, unitSellPrice}
  const map = {}
  for (const r of rows) {
    const t = r.specs.thickness, v = r.specs.variant, q = r.qty, f = r.finishing
    for (const tn of turnarounds) {
      const p = r.byTurnaround?.[tn]
      if (!p) continue
      map[tn] = map[tn] || {}
      map[tn][t] = map[tn][t] || {}
      map[tn][t][f] = map[tn][t][f] || {}
      map[tn][t][f][q] = map[tn][t][f][q] || {}
      map[tn][t][f][q][v] = p
    }
  }

  const thicks = [...new Set(rows.map(r => r.specs.thickness))]
  const finishings = [...new Set(rows.map(r => r.finishing))]
  const qtys = [...new Set(rows.map(r => r.qty))].sort((a, b) => a - b)

  let html = `<h2 style="margin:20px 0 10px;font-size:18px">
    ${prod.label} — ${size}
    <span style="color:var(--muted);font-size:12px;font-weight:400">${sides}-sided · ${markup}% markup</span>
  </h2>`

  for (const tn of turnarounds) {
    if (!map[tn]) continue
    html += `<h3 style="margin:18px 0 8px;font-size:14px;color:var(--accent)">${tnLabel(tn)}</h3>`
    html += `<div class="card" style="padding:0;overflow:hidden;margin-bottom:12px"><div class="price-table-wrap"><table>
      <thead><tr>
        <th>Product Name</th>
        <th>Thickness</th>
        <th>Qty</th>
        ${finishings.length > 1 ? '<th>Finishing</th>' : ''}
        ${variants.map(v => `<th>${varLabel(v)}</th>`).join('')}
      </tr></thead><tbody>`

    for (const t of thicks) {
      if (!map[tn][t]) continue
      let firstRow = true
      const rowCount = finishings.reduce((n, f) => n + (map[tn][t][f] ? Object.keys(map[tn][t][f]).length : 0), 0)
      for (const f of finishings) {
        if (!map[tn][t][f]) continue
        for (const q of qtys) {
          const varCell = map[tn][t][f][q]
          if (!varCell) continue
          html += `<tr>`
          html += `<td style="color:var(--muted);font-size:12px">${prod.label} — ${size}</td>`
          if (firstRow) {
            html += `<td class="row-key" rowspan="${rowCount}" style="vertical-align:middle;font-weight:600">${t}</td>`
            firstRow = false
          }
          html += `<td><strong>${q}</strong></td>`
          if (finishings.length > 1) html += `<td>${finLabel(f)}</td>`
          for (const v of variants) {
            const p = varCell[varKey(v)]
            html += p
              ? `<td><span class="sell">$${p.sellPrice}</span></td>`
              : `<td style="color:var(--muted)">—</td>`
          }
          html += `</tr>`
        }
      }
    }
    html += `</tbody></table></div></div>`
  }

  return html
}

// NCR price table: no finishing, one mini-table per turnaround, add-on combo columns
function renderNcrPriceTable(prod, rows, size, markup, turnarounds) {
  if (!rows.length) {
    return `<h2 style="margin:20px 0 10px;font-size:18px">${prod.label}</h2>
      <p style="color:var(--muted);padding:16px">No rows for this combo.</p>`
  }

  const allowedAddons = prod.allowed_addons || []
  const addonDefs = allowedAddons
    .map(k => ({ key: k, def: config.globals.addons[k] }))
    .filter(a => a.def)

  // Build power set of add-on combos
  const combos = [[]]
  for (const a of addonDefs) {
    const len = combos.length
    for (let i = 0; i < len; i++) combos.push([...combos[i], a])
  }
  const comboLabel = combo =>
    combo.length === 0 ? 'Base' : combo.map(a => a.def.label).join(' + ')

  // For each row and combo, compute the add-on cost (applied to base subtotal
  // BEFORE turnaround multiplier and markup). NCR add-ons are flat_per_pc.
  const markupMul = 1 + markup / 100
  const addonCostFor = (combo, qty) => {
    let total = 0
    for (const a of combo) {
      if (a.def.type === 'flat')        total += a.def.amount
      else if (a.def.type === 'flat_per_pc') total += a.def.amount * qty
    }
    return total
  }

  // Sort rows: size → variant → qty
  rows.sort((a, b) =>
    String(a.specs.size).localeCompare(String(b.specs.size)) ||
    String(a.specs.variant).localeCompare(String(b.specs.variant)) ||
    a.qty - b.qty)

  let html = `<h2 style="margin:20px 0 10px;font-size:18px">
    ${prod.label}
    <span style="color:var(--muted);font-size:12px;font-weight:400">${markup}% markup</span>
  </h2>`

  const variantLabel = k => {
    const v = (prod.options?.variant || []).find(x => (typeof x === 'object' ? x.key : x) === k)
    return v && typeof v === 'object' ? v.label : k
  }

  for (const tn of turnarounds) {
    const tnMul = config.globals.turnaround[tn]?.multiplier ?? 1
    html += `<h3 style="margin:18px 0 8px;font-size:14px;color:var(--accent)">${config.globals.turnaround[tn]?.label || tn}</h3>`
    html += `<div class="card" style="padding:0;overflow:hidden;margin-bottom:12px"><div class="price-table-wrap"><table>
      <thead><tr>
        <th>Product Name</th>
        <th>Size</th>
        <th>Variant</th>
        <th>Qty</th>
        ${combos.map(c => `<th>${comboLabel(c)}</th>`).join('')}
      </tr></thead><tbody>`

    for (const r of rows) {
      const basePrice = r.byTurnaround?.[tn]?.sellPrice
      if (basePrice == null) continue
      // Reverse-engineer the base subtotal for this turnaround:
      //   sellPrice = subtotal × tnMul × markupMul
      //   subtotal  = baseCost (no addons) + finishing(0) + addonCost(0)
      const baseSubtotal = basePrice / tnMul / markupMul

      html += `<tr>
        <td>${prod.label}</td>
        <td>${r.specs.size}</td>
        <td>${variantLabel(r.specs.variant)}</td>
        <td><strong>${r.qty}</strong></td>`
      for (const combo of combos) {
        const addonDelta = addonCostFor(combo, r.qty)
        const newSubtotal = baseSubtotal + addonDelta
        const newSell = newSubtotal * tnMul * markupMul
        html += `<td><span class="sell">$${newSell.toFixed(2)}</span></td>`
      }
      html += `</tr>`
    }
    html += `</tbody></table></div></div>`
  }

  return html
}

function renderEmptyStructure(prod, otherKeys, size, markup, sides, turnarounds) {
  // If thickness is filtered in the Price Table tab, narrow the cartesian to that one value
  const selectedThickness = document.getElementById('pt-thickness')?.value || ''
  const valueLists = otherKeys.map(k => {
    const opts = (prod.options?.[k] || []).map(o => typeof o === 'object' ? o.key : o)
    if (k === 'thickness' && selectedThickness) return opts.filter(v => v === selectedThickness)
    return opts
  })
  const combos = valueLists.length ? cartesian(valueLists) : [[]]
  const qtys = prod.quantities || []
  const finishings = allowedFinishingsFor(prod)

  let html = `<h2 style="margin:20px 0 10px;font-size:18px">
    ${prod.label} — ${size}
    <span style="color:var(--muted);font-size:12px;font-weight:400">${sides}-sided · ${markup}% markup</span>
  </h2>`

  html += `<div class="note" style="background:#fef3c7;border-left:3px solid #f59e0b">
    <strong>No prices entered for this size yet.</strong>
    The structure below is empty — go to the <strong>Prices</strong> tab, pick this product and size, and fill in the cells. The price table will populate automatically once you save.
  </div>`

  if (!combos.length || !qtys.length) {
    return html + '<p style="color:var(--muted);padding:16px">Add lookup options or quantity break points in the Products tab first.</p>'
  }

  html += `<div class="card" style="padding:0;overflow:hidden"><div class="price-table-wrap"><table>
    <thead><tr>
      <th>Size</th>
      ${otherKeys.map(k => `<th>${humanize(k)}</th>`).join('')}
      <th>Qty</th>
      <th>Finishing</th>
      ${turnarounds.map(tn => `<th>${config.globals.turnaround[tn]?.label || tn}<br><span style="font-weight:400;font-size:11px;color:var(--muted)">×${config.globals.turnaround[tn]?.multiplier || 1}</span></th>`).join('')}
    </tr></thead><tbody>`

  for (const combo of combos) {
    const labels = otherKeys.map((k, i) => formatKeyValue(prod, k, combo[i]))
    for (const q of qtys) {
      for (const f of finishings) {
        html += `<tr>
          <td>${size}</td>
          ${labels.map(l => `<td>${l}</td>`).join('')}
          <td><strong>${q}</strong></td>
          <td>${config.globals.finishings[f]?.label || f}</td>
          ${turnarounds.map(() => `<td style="color:var(--muted)">—</td>`).join('')}
        </tr>`
      }
    }
  }

  html += `</tbody></table></div></div>`
  return html
}

// Look up the human label for a lookup-key value (handles {key,label} variants)
function formatKeyValue(prod, key, value) {
  const opt = (prod.options?.[key] || []).find(o => (typeof o === 'object' ? o.key : o) === value)
  if (opt && typeof opt === 'object') return opt.label
  return String(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICES TAB — edit price tables for one size at a time
// ─────────────────────────────────────────────────────────────────────────────
let pricesProdKey = null

function initPrices() {
  const prodSel = document.getElementById('pr-product')
  populateSelect(prodSel, Object.entries(config.products).map(([k, v]) => ({ value: k, label: v.label })))
  prodSel.addEventListener('change', onPricesProductChange)
  document.getElementById('pr-save').addEventListener('click', savePrices)
  onPricesProductChange()
}

function onPricesProductChange() {
  pricesProdKey = document.getElementById('pr-product').value
  renderPricesGrid()
}

function renderPricesGrid() {
  const prod = config.products[pricesProdKey]
  const grid = document.getElementById('pr-grid')
  if (!prod) { grid.innerHTML = ''; return }

  if (prod.mode === 'ncr') {
    grid.innerHTML = `<p style="color:var(--muted);padding:16px">
      ${prod.label} uses a setup + slope cost model, not a per-cell price table.
      Edit setup costs and marginal-per-book in the <strong>Products</strong> tab.
    </p>`
    return
  }

  if (isPivotVariantProduct(prod)) {
    grid.innerHTML = renderCoroplastPrices(prod)
    return
  }

  const sizes = prod.options?.size || []
  const otherKeys = (prod.lookup_keys || []).filter(k => k !== 'size')
  const qtys = prod.quantities || []

  if (!qtys.length) { grid.innerHTML = '<p style="color:var(--muted);padding:16px">No quantity break points yet — add some in the Products tab.</p>'; return }
  if (!sizes.length) { grid.innerHTML = '<p style="color:var(--muted);padding:16px">No sizes defined yet — add some in the Products tab.</p>'; return }

  let html = ''
  for (const size of sizes) {
    const sizeRows = (prod.price_table || []).filter(r => r.key.size === size)

    html += `<h3 style="margin:24px 0 8px;font-size:16px;border-bottom:2px solid var(--accent);padding-bottom:6px">${prod.label} — ${size}</h3>`

    if (!sizeRows.length) {
      html += '<p style="color:var(--muted);padding:8px 0 16px;font-size:13px">No combos for this size yet — add options in the Products tab.</p>'
      continue
    }

    html += `<div class="card" style="padding:0;overflow:hidden;margin-bottom:16px"><div class="price-table-wrap"><table class="price-grid">
      <thead><tr>`
    for (const k of otherKeys) html += `<th>${humanize(k)}</th>`
    for (const q of qtys)      html += `<th>${q}</th>`
    html += `</tr></thead><tbody>`

    for (const row of sizeRows) {
      const idx = prod.price_table.indexOf(row)
      html += `<tr>`
      for (const k of otherKeys) {
        const v = row.key[k]
        const opt = (prod.options[k] || []).find(o => (typeof o === 'object' ? o.key : o) === v)
        const label = opt && typeof opt === 'object' ? opt.label : v
        html += `<td class="row-key">${label}</td>`
      }
      for (const q of qtys) {
        html += `<td><input type="number" step="0.01" data-pr-row="${idx}" data-pr-qty="${q}" value="${row.prices[q] ?? ''}" /></td>`
      }
      html += `</tr>`
    }
    html += `</tbody></table></div></div>`
  }

  grid.innerHTML = html
}

// Coroplast-specific Prices layout — mirrors the Excel:
//   one mini-table per size, rows = thickness × qty, columns = variants
function renderCoroplastPrices(prod) {
  const sizes      = prod.options?.size || []
  const thicks     = prod.options?.thickness || []
  const variants   = prod.options?.variant || []
  const qtys       = prod.quantities || []
  const varKey     = v => typeof v === 'object' ? v.key : v
  const varLabel   = v => typeof v === 'object' ? v.label : v

  let html = ''
  for (const size of sizes) {
    html += `<h3 style="margin:24px 0 8px;font-size:16px;border-bottom:2px solid var(--accent);padding-bottom:6px">${prod.label} — ${size}</h3>`

    html += `<div class="card" style="padding:0;overflow:hidden;margin-bottom:16px"><div class="price-table-wrap"><table class="price-grid">
      <thead>
        <tr>
          <th>Thickness</th><th>Qty</th>
          ${variants.map(v => `<th>${varLabel(v)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>`

    for (const t of thicks) {
      for (let qi = 0; qi < qtys.length; qi++) {
        const q = qtys[qi]
        html += `<tr>`
        html += qi === 0
          ? `<td class="row-key" rowspan="${qtys.length}" style="vertical-align:middle;font-weight:600">${t}</td>`
          : ''
        html += `<td class="row-key">${q}</td>`
        for (const v of variants) {
          const vk  = varKey(v)
          const row = (prod.price_table || []).find(r =>
            r.key.thickness === t && r.key.size === size && r.key.variant === vk)
          if (!row) {
            html += `<td style="color:var(--muted)">—</td>`
            continue
          }
          const idx = prod.price_table.indexOf(row)
          const val = row.prices[q] ?? ''
          html += `<td><input type="number" step="0.01" data-pr-row="${idx}" data-pr-qty="${q}" value="${val}" /></td>`
        }
        html += `</tr>`
      }
    }

    html += `</tbody></table></div></div>`
  }
  return html
}

function capturePricesEdits() {
  const prod = config.products[pricesProdKey]
  if (!prod) return
  document.querySelectorAll('#pr-grid input[data-pr-row]').forEach(inp => {
    const row = parseInt(inp.dataset.prRow)
    const qty = parseInt(inp.dataset.prQty)
    const v = inp.value === '' ? null : parseFloat(inp.value)
    if (prod.price_table[row]) {
      if (v == null) delete prod.price_table[row].prices[qty]
      else           prod.price_table[row].prices[qty] = v
    }
  })
}

function savePrices() {
  capturePricesEdits()
  saveConfig().catch(e => toast(e.message, 'err'))
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTS TAB
// ─────────────────────────────────────────────────────────────────────────────
function initProducts() {
  renderProductList()
  document.getElementById('prod-save').addEventListener('click', saveProduct)
}

function renderProductList() {
  const ul = document.getElementById('prod-list')
  ul.innerHTML = ''
  for (const [key, prod] of Object.entries(config.products)) {
    const li = document.createElement('li')
    li.dataset.key = key
    li.innerHTML = `<span class="list-label">${prod.label}</span><span class="list-sub">mode: ${prod.mode || 'formula'}</span>`
    li.addEventListener('click', () => openProduct(key))
    ul.appendChild(li)
  }
}

function openProduct(key) {
  currentProdKey = key
  const prod = config.products[key]
  document.querySelectorAll('#prod-list li').forEach(li => li.classList.toggle('active', li.dataset.key === key))
  document.getElementById('prod-editor-title').textContent = prod.label
  document.getElementById('prod-editor-sub').textContent   = `key: ${key} · mode: ${prod.mode}`
  document.getElementById('prod-empty').style.display = 'none'
  document.getElementById('prod-editor').style.display = 'flex'

  const body = document.getElementById('prod-editor-body')
  if (prod.mode === 'lookup')   body.innerHTML = editorLookup(prod)
  else if (prod.mode === 'ncr') body.innerHTML = editorNcr(prod)
  else                          body.innerHTML = `<p style="padding:20px;color:var(--muted)">No editor for mode "${prod.mode}".</p>`
}

// ── NCR editor ─ setup table + marginal-per-size ─────────────────────────────
function editorNcr(prod) {
  const sizes    = prod.options?.size || []
  const variants = prod.options?.variant || []
  const labelOf  = v => typeof v === 'object' ? v.label : v
  const keyOf    = v => typeof v === 'object' ? v.key   : v

  let html = `<div class="card">`

  html += `<div class="note">
    <strong>NCR pricing — setup + slope model.</strong>
    <ul>
      <li>Each size has a <strong>marginal cost per book</strong> (the per-book labour + paper). Same across variants of that size.</li>
      <li>Each <strong>(size, variant)</strong> has a <strong>setup cost</strong> — the per-job fixed cost (plate, ink, registration, carbonless parts).</li>
      <li>Quote formula: <code>line_total = setup + marginal × qty + book_wrap×qty + numbering×qty</code></li>
      <li>Add or delete a size → the table auto-rebuilds. Same for variants.</li>
      <li>Re-running the Excel importer wipes manual edits.</li>
    </ul>
  </div>`

  // Sizes chip list
  html += `<div class="editor-section">
    <h3>Sizes</h3>
    <div class="chip-list">
      ${sizes.map(s => `<span class="chip">${s}<button onclick="removeNcrSize('${escapeAttr(s)}')">✕</button></span>`).join('')}
    </div>
    <div class="chip-add">
      <input id="add-ncr-size" placeholder="add new size (e.g. 11x17)" />
      <button onclick="addNcrSize()">+ Add Size</button>
    </div>
  </div>`

  // Variants chip list
  html += `<div class="editor-section">
    <h3>Variants</h3>
    <div class="chip-list">
      ${variants.map(v => `<span class="chip">${labelOf(v)}<button onclick="removeNcrVariant('${escapeAttr(keyOf(v))}')">✕</button></span>`).join('')}
    </div>
    <div class="chip-add">
      <input id="add-ncr-variant-key"   placeholder="key (e.g. 4part_single)" style="max-width:170px" />
      <input id="add-ncr-variant-label" placeholder="label (e.g. 4 Part — Single Color)" />
      <button onclick="addNcrVariant()">+ Add Variant</button>
    </div>
  </div>`

  // Marginal per book per size
  html += `<div class="editor-section">
    <h3>Marginal Cost per Book (by size)</h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:6px">
      The per-book variable cost. Same across all variants of that size.
    </p>
    <table class="price-grid">
      <thead><tr><th>Size</th><th>$ / book</th></tr></thead>
      <tbody>
        ${sizes.map(s => `
          <tr>
            <td class="row-key">${s}</td>
            <td><input type="number" step="0.01" data-ncr-marginal="${escapeAttr(s)}" value="${prod.marginal_per_book?.[s] ?? ''}" /></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`

  // Setup matrix (variants × sizes)
  html += `<div class="editor-section">
    <h3>Setup Cost by Variant × Size</h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:6px">
      Per-job fixed cost. Plate setup, ink, carbonless copies, etc.
    </p>
    <table class="price-grid">
      <thead><tr><th>Variant</th>${sizes.map(s => `<th>${s}</th>`).join('')}</tr></thead>
      <tbody>
        ${variants.map(v => {
          const vKey = keyOf(v)
          return `<tr>
            <td class="row-key">${labelOf(v)}</td>
            ${sizes.map(s => `<td><input type="number" step="0.01" data-ncr-setup-size="${escapeAttr(s)}" data-ncr-setup-variant="${escapeAttr(vKey)}" value="${prod.setup?.[s]?.[vKey] ?? ''}" /></td>`).join('')}
          </tr>`
        }).join('')}
      </tbody>
    </table>
  </div>`

  // Quantity break points (display only — used by price table generator)
  html += `<div class="editor-section">
    <h3>Quantity Break Points (display only)</h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:6px">
      Quantities to show in the generated price table. NCR can quote any qty — these are just the rows the table displays.
    </p>
    <div class="chip-list">
      ${(prod.quantities || []).map(q => `<span class="chip">${q}<button onclick="removeQty(${q})">✕</button></span>`).join('')}
    </div>
    <div class="chip-add">
      <input id="add-qty" type="number" placeholder="add qty" />
      <button onclick="addQty()">+ Add</button>
    </div>
  </div>`

  // Allowed turnarounds / add-ons / finishings — undefined = pre-tick all so user can untick
  const tnList   = prod.allowed_turnarounds || Object.keys(config.globals.turnaround)
  const adList   = prod.allowed_addons      || Object.keys(config.globals.addons)
  const finList2 = prod.allowed_finishings  || Object.keys(config.globals.finishings)
  html += `<div class="editor-section">
    <h3>Available Turnarounds</h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:6px">Tick what this product offers. Untick to remove from the price table.</p>
    <div class="checkbox-grid" id="prod-turnarounds">
      ${Object.entries(config.globals.turnaround).map(([k, v]) =>
        `<label><input type="checkbox" value="${k}" ${tnList.includes(k) ? 'checked' : ''}/> ${v.label} <span style="color:var(--muted);font-size:11px">×${v.multiplier}</span></label>`).join('')}
    </div>
  </div>`

  html += `<div class="editor-section">
    <h3>Allowed Add-ons</h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:6px">Tick what this product can take.</p>
    <div class="checkbox-grid" id="prod-addons">
      ${Object.entries(config.globals.addons).map(([k, v]) =>
        `<label><input type="checkbox" value="${k}" ${adList.includes(k) ? 'checked' : ''}/> ${v.label}</label>`).join('')}
    </div>
  </div>`

  html += `<div class="editor-section">
    <h3>Available Finishings</h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:6px">Tick what this product can take.</p>
    <div class="checkbox-grid" id="prod-finishings">
      ${Object.entries(config.globals.finishings).map(([k, v]) =>
        `<label><input type="checkbox" value="${k}" ${finList2.includes(k) ? 'checked' : ''}/> ${v.label}</label>`).join('')}
    </div>
  </div>`

  html += `</div>`
  return html
}

window.addNcrSize = function () {
  captureNcrEdits()
  const input = document.getElementById('add-ncr-size')
  const v = input.value.trim()
  if (!v) return
  const prod = config.products[currentProdKey]
  if (!prod.options.size.includes(v)) prod.options.size.push(v)
  prod.setup[v] = prod.setup[v] || {}
  prod.marginal_per_book[v] = prod.marginal_per_book[v] ?? 0
  refreshEditor()
}

window.removeNcrSize = function (size) {
  captureNcrEdits()
  const prod = config.products[currentProdKey]
  prod.options.size = prod.options.size.filter(s => s !== size)
  delete prod.setup[size]
  delete prod.marginal_per_book[size]
  refreshEditor()
}

window.addNcrVariant = function () {
  captureNcrEdits()
  const k = document.getElementById('add-ncr-variant-key').value.trim()
  const l = document.getElementById('add-ncr-variant-label').value.trim() || k
  if (!k) return
  const prod = config.products[currentProdKey]
  const exists = prod.options.variant.some(v => (typeof v === 'object' ? v.key : v) === k)
  if (!exists) prod.options.variant.push({ key: k, label: l })
  for (const s of prod.options.size) {
    prod.setup[s] = prod.setup[s] || {}
    prod.setup[s][k] = prod.setup[s][k] ?? 0
  }
  refreshEditor()
}

window.removeNcrVariant = function (key) {
  captureNcrEdits()
  const prod = config.products[currentProdKey]
  prod.options.variant = prod.options.variant.filter(v => (typeof v === 'object' ? v.key : v) !== key)
  for (const s of Object.keys(prod.setup || {})) delete prod.setup[s][key]
  refreshEditor()
}

function captureNcrEdits() {
  const prod = config.products[currentProdKey]
  if (prod.mode !== 'ncr') return
  prod.setup = prod.setup || {}
  prod.marginal_per_book = prod.marginal_per_book || {}
  document.querySelectorAll('input[data-ncr-marginal]').forEach(inp => {
    const s = inp.dataset.ncrMarginal
    const v = parseFloat(inp.value)
    if (!isNaN(v)) prod.marginal_per_book[s] = v
  })
  document.querySelectorAll('input[data-ncr-setup-size]').forEach(inp => {
    const s = inp.dataset.ncrSetupSize
    const k = inp.dataset.ncrSetupVariant
    const v = parseFloat(inp.value)
    prod.setup[s] = prod.setup[s] || {}
    if (!isNaN(v)) prod.setup[s][k] = v
  })
}

// ── Lookup editor ─ size-scoped ──────────────────────────────────────────────
//
// New mental model: pick a size first, then see only the rows for that size.
// Other lookup keys (paper stock, folding, pages, cover, …) become the rows
// of a small grid that's specific to the chosen size. Adding a paper stock
// auto-creates rows for the current size combos. No more "variant rows".
//
function editorLookup(prod) {
  const keys = prod.lookup_keys || []
  const otherKeys = keys.filter(k => k !== 'size')

  let html = `<div class="card">`

  html += `<div class="note">
    <strong>This is the structural setup for ${prod.label}.</strong>
    <ul>
      <li>Edit the <strong>sizes</strong>, <strong>${otherKeys.join(', ') || 'options'}</strong>, <strong>quantity break points</strong>, allowed add-ons and finishings.</li>
      <li>To edit actual prices, go to the <strong>Prices</strong> tab.</li>
      <li>Adding or deleting a value auto-creates / removes price-table rows in the background. Deleting a value drops every price that used it — no undo.</li>
      <li>Re-running the Excel importer wipes manual edits — only re-import when you have a new workbook.</li>
    </ul>
  </div>`

  // Size chip management — if product has sheet_imposition, sizes come from there
  if (!prod.sheet_imposition) {
    html += `<div class="editor-section">
      <h3>Sizes</h3>
      <div class="chip-list">
        ${(prod.options.size || []).map(s => `<span class="chip">${s}<button onclick="removeLookupValue('size','${escapeAttr(s)}')">✕</button></span>`).join('')}
      </div>
      <div class="chip-add">
        <input id="add-size" placeholder="add new size (e.g. 9 x 12)" />
        <button onclick="addLookupValue('size')">+ Add Size</button>
      </div>
    </div>`
  }

  // Each non-size key gets its own chip list — adding a value auto-creates rows
  for (const k of otherKeys) {
    const opts = prod.options[k] || []
    const labelOf = v => typeof v === 'object' ? v.label : v
    const keyOf   = v => typeof v === 'object' ? v.key   : v

    // Missing default values the user may have accidentally deleted
    const defaults = DEFAULT_OPTIONS[currentProdKey]?.[k] || []
    const currentKeys = new Set(opts.map(keyOf))
    const missing = defaults.filter(d => !currentKeys.has(typeof d === 'object' ? d.key : d))

    html += `<div class="editor-section">
      <h3>${humanize(k)}</h3>
      <div class="chip-list">
        ${opts.map(v => `<span class="chip">${labelOf(v)}<button onclick="removeLookupValue('${k}','${escapeAttr(keyOf(v))}')">✕</button></span>`).join('')}
      </div>
      ${missing.length ? `
      <div style="margin-top:8px;padding:8px 12px;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px">
        <strong>Missing defaults:</strong>
        <div class="chip-list" style="margin-top:6px">
          ${missing.map(d => {
            const dk = typeof d === 'object' ? d.key : d
            const dl = typeof d === 'object' ? d.label : d
            return `<span class="chip" style="background:#dbeafe;cursor:pointer" onclick="restoreDefaultOption('${k}','${escapeAttr(dk)}')" title="Click to restore">+ ${dl}</span>`
          }).join('')}
          ${missing.length > 1 ? `<button class="btn-secondary btn-sm" onclick="restoreAllDefaultOptions('${k}')">Restore all</button>` : ''}
        </div>
      </div>` : ''}
      <div class="chip-add">
        <input id="add-${k}" placeholder="add new ${humanize(k).toLowerCase()}" />
        <button onclick="addLookupValue('${k}')">+ Add</button>
      </div>
    </div>`
  }

  // Quantities
  html += `<div class="editor-section">
    <h3>Quantity Columns</h3>
    <div class="chip-list">
      ${(prod.quantities || []).map(q => `<span class="chip">${q}<button onclick="removeQty(${q})">✕</button></span>`).join('')}
    </div>
    <div class="chip-add">
      <input id="add-qty" type="number" placeholder="add qty" />
      <button onclick="addQty()">+ Add</button>
    </div>
  </div>`

  // Sheet imposition table — also the single source of sizes for this product
  if (prod.sheet_imposition) {
    const si = prod.sheet_imposition
    html += `<div class="editor-section">
      <h3>Sheet Imposition (pieces per ${si.master || 'master'} sheet)</h3>
      <p style="font-size:12px;color:var(--muted);margin-bottom:6px">
        Sizes are managed here. Adding or removing a row updates the product's size list and price table automatically.
      </p>
      <table class="price-grid" id="sheet-imp-table">
        <thead><tr><th>Size</th><th>Pieces / Sheet</th><th></th></tr></thead>
        <tbody>
          ${Object.entries(si.pieces_per_sheet || {}).map(([sz, n]) => `
            <tr>
              <td><input data-imp-key value="${sz}" /></td>
              <td><input data-imp-val type="number" min="1" value="${n}" /></td>
              <td><button class="btn-mini" onclick="removeImpRow(this)">✕</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
      <button class="btn-secondary" style="margin-top:6px" onclick="addImpRow()">+ Add Size</button>
    </div>`
  }

  // Allowed turnarounds — when undefined, treat as "all on" (legacy default)
  // so the user sees the current effective state and can untick what they
  // don't want. Once saved, only the ticked ones are stored.
  const tnList = prod.allowed_turnarounds || Object.keys(config.globals.turnaround)
  html += `<div class="editor-section">
    <h3>Available Turnarounds
      <button class="btn-secondary btn-sm" style="margin-left:12px" onclick="toggleAllChecks('prod-turnarounds', true)">All</button>
      <button class="btn-secondary btn-sm" onclick="toggleAllChecks('prod-turnarounds', false)">None</button>
    </h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:6px">
      Tick the turnaround speeds this product offers. Untick to remove from the price table.
    </p>
    <div class="checkbox-grid" id="prod-turnarounds">
      ${Object.entries(config.globals.turnaround).map(([k, v]) =>
        `<label><input type="checkbox" value="${k}" ${tnList.includes(k) ? 'checked' : ''}/> ${v.label} <span style="color:var(--muted);font-size:11px">×${v.multiplier}</span></label>`).join('')}
    </div>
  </div>`

  // Allowed finishings — same logic
  const finList = prod.allowed_finishings || Object.keys(config.globals.finishings)
  html += `<div class="editor-section">
    <h3>Available Finishings
      <button class="btn-secondary btn-sm" style="margin-left:12px" onclick="toggleAllChecks('prod-finishings', true)">All</button>
      <button class="btn-secondary btn-sm" onclick="toggleAllChecks('prod-finishings', false)">None</button>
    </h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:6px">
      Tick the finishings this product can take. Untick to remove from the price table.
    </p>
    <div class="checkbox-grid" id="prod-finishings">
      ${Object.entries(config.globals.finishings).map(([k, v]) =>
        `<label><input type="checkbox" value="${k}" ${finList.includes(k) ? 'checked' : ''}/> ${v.label}</label>`).join('')}
    </div>
  </div>`

  html += `</div>`
  return html
}

function humanize(s) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
function escapeAttr(s) {
  return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;')
}

window.toggleAllChecks = function (gridId, checked) {
  document.querySelectorAll(`#${gridId} input[type="checkbox"]`).forEach(cb => cb.checked = checked)
}

window.addImpRow = function () {
  const tbody = document.querySelector('#sheet-imp-table tbody')
  if (!tbody) return
  const tr = document.createElement('tr')
  tr.innerHTML = `
    <td><input data-imp-key value="" placeholder="e.g. 36x48" /></td>
    <td><input data-imp-val type="number" min="1" value="1" /></td>
    <td><button class="btn-mini" onclick="removeImpRow(this)">✕</button></td>`
  tbody.appendChild(tr)
}
window.removeImpRow = function (btn) {
  btn.closest('tr').remove()
}

function captureSheetImposition(prod) {
  const tbl = document.querySelector('#sheet-imp-table')
  if (!tbl) return
  const out = {}
  tbl.querySelectorAll('tbody tr').forEach(tr => {
    const k = tr.querySelector('[data-imp-key]')?.value.trim()
    const v = parseInt(tr.querySelector('[data-imp-val]')?.value)
    if (k && !isNaN(v)) out[k] = v
  })
  prod.sheet_imposition.pieces_per_sheet = out
  // Sync options.size from sheet imposition keys
  prod.options.size = Object.keys(out)
  // Drop price_table rows for sizes that no longer exist
  const sizeSet = new Set(prod.options.size)
  prod.price_table = (prod.price_table || []).filter(r => sizeSet.has(r.key.size))
  // Rebuild to add rows for any new sizes
  rebuildRowsForCombo(prod)
}


// ── Lookup editor mutations ──────────────────────────────────────────────────

window.addLookupValue = function (keyName) {
  const input = document.getElementById(`add-${keyName}`)
  const v = input.value.trim()
  if (!v) return
  const prod = config.products[currentProdKey]
  if (!prod.options[keyName]) prod.options[keyName] = []
  // Avoid duplicates — compare against both key and label (case-insensitive)
  const norm = s => String(s).trim().toLowerCase()
  const exists = prod.options[keyName].some(o => {
    const k = typeof o === 'object' ? o.key   : o
    const l = typeof o === 'object' ? o.label : o
    return norm(k) === norm(v) || norm(l) === norm(v)
  })
  if (!exists) prod.options[keyName].push(v)
  input.value = ''
  // Auto-create price-table rows for every combo that uses this new value
  rebuildRowsForCombo(prod)
  refreshEditor()
}

// Restore a single missing default option (key + label)
window.restoreDefaultOption = function (keyName, valueKey) {
  const prod = config.products[currentProdKey]
  const defaults = DEFAULT_OPTIONS[currentProdKey]?.[keyName] || []
  const def = defaults.find(d => (typeof d === 'object' ? d.key : d) === valueKey)
  if (!def) return
  if (!prod.options[keyName]) prod.options[keyName] = []
  // Only add if truly missing (by key)
  const currentKeys = new Set(prod.options[keyName].map(o => typeof o === 'object' ? o.key : o))
  if (currentKeys.has(valueKey)) return
  prod.options[keyName].push(def)
  rebuildRowsForCombo(prod)
  refreshEditor()
}

// Restore all missing default options for a given key
window.restoreAllDefaultOptions = function (keyName) {
  const prod = config.products[currentProdKey]
  const defaults = DEFAULT_OPTIONS[currentProdKey]?.[keyName] || []
  if (!prod.options[keyName]) prod.options[keyName] = []
  const currentKeys = new Set(prod.options[keyName].map(o => typeof o === 'object' ? o.key : o))
  for (const d of defaults) {
    const dk = typeof d === 'object' ? d.key : d
    if (!currentKeys.has(dk)) prod.options[keyName].push(d)
  }
  rebuildRowsForCombo(prod)
  refreshEditor()
}

window.removeLookupValue = function (keyName, value) {
  const prod = config.products[currentProdKey]
  prod.options[keyName] = (prod.options[keyName] || []).filter(v => {
    if (typeof v === 'object') return v.key !== value
    return String(v) !== String(value)
  })
  // Drop any price_table rows referencing this value
  prod.price_table = (prod.price_table || []).filter(r => String(r.key[keyName]) !== String(value))
  refreshEditor()
}

window.addQty = function () {
  const input = document.getElementById('add-qty')
  const q = parseInt(input.value)
  if (isNaN(q)) return
  const prod = config.products[currentProdKey]
  if (!prod.quantities.includes(q)) prod.quantities.push(q)
  prod.quantities.sort((a, b) => a - b)
  input.value = ''
  refreshEditor()
}

window.removeQty = function (q) {
  const prod = config.products[currentProdKey]
  prod.quantities = (prod.quantities || []).filter(x => x !== q)
  for (const row of (prod.price_table || [])) delete row.prices[q]
  refreshEditor()
}

/**
 * Make sure price_table contains exactly one row per cartesian combination
 * of lookup_keys × options. Existing rows keep their prices; new ones start
 * empty. Stale rows referencing removed options are dropped.
 */
function rebuildRowsForCombo(prod) {
  const keys = prod.lookup_keys || []
  if (!keys.length) return
  const valueLists = keys.map(k => (prod.options[k] || []).map(o => typeof o === 'object' ? o.key : o))
  if (valueLists.some(l => !l.length)) return    // can't build combos until every key has at least one value

  const combos = cartesian(valueLists)
  const existing = prod.price_table || []
  const next = []
  for (const combo of combos) {
    const key = {}
    keys.forEach((k, i) => key[k] = combo[i])
    const found = existing.find(r => keys.every(k => String(r.key[k]) === String(key[k])))
    next.push(found || { key, prices: {} })
  }
  prod.price_table = next
}

function cartesian(arrays) {
  return arrays.reduce((acc, arr) => {
    const out = []
    for (const a of acc) for (const b of arr) out.push([...a, b])
    return out
  }, [[]])
}

function refreshEditor() {
  openProduct(currentProdKey)
}

// ── Save product ─────────────────────────────────────────────────────────────
function saveProduct() {
  const prod = config.products[currentProdKey]
  if (!prod) return

  if (prod.mode === 'ncr')   captureNcrEdits()
  if (prod.sheet_imposition) captureSheetImposition(prod)

  // Capture allowed finishings (every editor) and allowed add-ons.
  // Empty list = delete the field, which the engine treats as "allow all".
  const captureChecks = id => {
    const grid = document.querySelector(`#${id}`)
    if (!grid) return null
    return [...grid.querySelectorAll('input:checked')].map(i => i.value)
  }

  // Always store the explicit list — even if empty. Empty = "user explicitly
  // unticked everything", not "default to all".
  const finTicked   = captureChecks('prod-finishings')
  const addonTicked = captureChecks('prod-addons')
  const tnTicked    = captureChecks('prod-turnarounds')
  if (finTicked   != null) prod.allowed_finishings  = finTicked
  if (addonTicked != null) prod.allowed_addons      = addonTicked
  if (tnTicked    != null) prod.allowed_turnarounds = tnTicked


  saveConfig().then(() => {
    renderProductList()
    document.querySelectorAll('#prod-list li').forEach(li => li.classList.toggle('active', li.dataset.key === currentProdKey))
    // Re-open so the editor reflects the saved state
    openProduct(currentProdKey)
  }).catch(e => toast(e.message, 'err'))
}

// ─────────────────────────────────────────────────────────────────────────────
// FINISHINGS TAB
// ─────────────────────────────────────────────────────────────────────────────
function initFinishings() {
  refreshFinishingSelect()
  document.getElementById('fin-select').addEventListener('change', loadFinishing)
  document.getElementById('fin-new').addEventListener('click', newFinishing)
  document.getElementById('fin-save').addEventListener('click', saveFinishing)
  document.getElementById('fin-delete').addEventListener('click', deleteFinishing)
}

function refreshFinishingSelect() {
  const sel = document.getElementById('fin-select')
  populateSelect(sel, [
    { value: '', label: '— select —' },
    ...Object.entries(config.globals.finishings).map(([k, v]) => ({ value: k, label: v.label }))
  ])
  document.getElementById('fin-editor').style.display = 'none'
}

function loadFinishing() {
  const key = document.getElementById('fin-select').value
  if (!key) { document.getElementById('fin-editor').style.display = 'none'; return }
  const fin = config.globals.finishings[key]
  document.getElementById('fin-key').value      = key
  document.getElementById('fin-label').value    = fin.label
  document.getElementById('fin-flat').value     = fin.flat
  document.getElementById('fin-per-unit').value = fin.per_unit
  document.getElementById('fin-editor').style.display = 'block'
}

function newFinishing() {
  document.getElementById('fin-select').value = ''
  document.getElementById('fin-key').value = ''
  document.getElementById('fin-label').value = ''
  document.getElementById('fin-flat').value = '0'
  document.getElementById('fin-per-unit').value = '0'
  document.getElementById('fin-editor').style.display = 'block'
}

function saveFinishing() {
  const oldKey = document.getElementById('fin-select').value
  const newKey = document.getElementById('fin-key').value.trim()
  if (!newKey) { toast('Key required', 'err'); return }
  if (oldKey && oldKey !== newKey) delete config.globals.finishings[oldKey]
  config.globals.finishings[newKey] = {
    label:    document.getElementById('fin-label').value.trim(),
    flat:     parseFloat(document.getElementById('fin-flat').value),
    per_unit: parseFloat(document.getElementById('fin-per-unit').value),
  }
  saveConfig().then(() => {
    refreshFinishingSelect()
    document.getElementById('fin-select').value = newKey
    loadFinishing()
    if (currentProdKey) openProduct(currentProdKey)
  }).catch(e => toast(e.message, 'err'))
}

function deleteFinishing() {
  const key = document.getElementById('fin-select').value
  if (!key || !confirm(`Delete "${key}"?`)) return
  delete config.globals.finishings[key]
  saveConfig().then(() => refreshFinishingSelect())
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBALS TAB — turnaround multipliers + add-ons
// ─────────────────────────────────────────────────────────────────────────────
function initGlobals() {
  renderGlobals()
  document.getElementById('globals-save').addEventListener('click', saveGlobals)
}

function renderGlobals() {
  const body = document.getElementById('globals-body')
  let html = ''

  html += `<div class="note">
    <strong>Heads up — please read before editing:</strong>
    <ul>
      <li><strong>Globals apply to every product</strong> that opts in (via the Allowed Turnarounds / Add-ons checkboxes on each product).</li>
      <li><strong>Turnaround</strong> is a <em>multiplier</em> on the cost subtotal — <code>1.0</code> = no change, <code>1.3</code> = +30%. Always keep <code>regular</code> = 1.0 as the baseline.</li>
      <li><strong>Add-on types:</strong>
        <code>flat</code> = one-time charge per order;
        <code>flat_per_pc</code> = $ × number of pieces (e.g. grommets);
        <code>pct_of_base</code> = % of the base cost (e.g. two-sided printing).</li>
      <li><strong>Renaming a key</strong> (e.g. <code>grommet</code> → <code>grommets</code>) breaks any product that referenced the old key. After renaming, re-tick it on every product that should still use it.</li>
      <li><strong>Deleting</strong> a turnaround or add-on does <em>not</em> remove it from each product's Allowed list — re-save the affected products if you want a clean state.</li>
    </ul>
  </div>`

  html += `<div class="global-block"><h3 style="margin-bottom:10px">Turnaround Multipliers</h3>`
  html += `<table class="price-grid"><thead><tr><th>Key</th><th>Label</th><th>Multiplier</th><th></th></tr></thead><tbody>`
  for (const [k, v] of Object.entries(config.globals.turnaround)) {
    html += `<tr>
      <td><input data-tn-key="${k}" data-field="key"        value="${k}" /></td>
      <td><input data-tn-key="${k}" data-field="label"      value="${v.label}" /></td>
      <td><input data-tn-key="${k}" data-field="multiplier" type="number" step="0.01" value="${v.multiplier}" /></td>
      <td><button class="btn-mini" onclick="removeTurnaround('${k}')">✕</button></td>
    </tr>`
  }
  html += `</tbody></table>
    <button class="btn-secondary" style="margin-top:8px" onclick="addTurnaround()">+ Add Turnaround</button>
  </div>`

  html += `<div class="global-block"><h3 style="margin-bottom:10px">Add-ons</h3>`
  html += `<table class="price-grid"><thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Amount</th><th></th></tr></thead><tbody>`
  for (const [k, v] of Object.entries(config.globals.addons)) {
    html += `<tr>
      <td><input data-ad-key="${k}" data-field="key"    value="${k}" /></td>
      <td><input data-ad-key="${k}" data-field="label"  value="${v.label}" /></td>
      <td>
        <select data-ad-key="${k}" data-field="type">
          <option value="flat"         ${v.type === 'flat' ? 'selected' : ''}>flat</option>
          <option value="flat_per_pc"  ${v.type === 'flat_per_pc' ? 'selected' : ''}>flat per pc</option>
          <option value="pct_of_base"  ${v.type === 'pct_of_base' ? 'selected' : ''}>% of base</option>
        </select>
      </td>
      <td><input data-ad-key="${k}" data-field="amount" type="number" step="0.01" value="${v.amount}" /></td>
      <td><button class="btn-mini" onclick="removeAddon('${k}')">✕</button></td>
    </tr>`
  }
  html += `</tbody></table>
    <button class="btn-secondary" style="margin-top:8px" onclick="addAddon()">+ Add Add-on</button>
  </div>`

  body.innerHTML = html
}

function captureGlobals() {
  // Turnaround — rebuild map
  const tn = {}
  document.querySelectorAll('#globals-body tbody tr').forEach(tr => {
    const isTn = tr.querySelector('input[data-tn-key]')
    if (!isTn) return
    const inputs = tr.querySelectorAll('input')
    const key = inputs[0].value.trim()
    if (!key) return
    tn[key] = { label: inputs[1].value.trim(), multiplier: parseFloat(inputs[2].value) || 1 }
  })
  if (Object.keys(tn).length) config.globals.turnaround = tn

  // Add-ons — rebuild map
  const ad = {}
  document.querySelectorAll('#globals-body tbody tr').forEach(tr => {
    const isAd = tr.querySelector('input[data-ad-key]')
    if (!isAd) return
    const inputs = tr.querySelectorAll('input')
    const sel    = tr.querySelector('select')
    const key = inputs[0].value.trim()
    if (!key) return
    ad[key] = {
      label:  inputs[1].value.trim(),
      type:   sel.value,
      amount: parseFloat(inputs[2].value) || 0,
    }
  })
  if (Object.keys(ad).length) config.globals.addons = ad
}

window.addTurnaround = function () {
  captureGlobals()
  let n = 1
  while (config.globals.turnaround['new' + n]) n++
  config.globals.turnaround['new' + n] = { label: 'New', multiplier: 1 }
  renderGlobals()
}
window.removeTurnaround = function (k) {
  captureGlobals()
  delete config.globals.turnaround[k]
  renderGlobals()
}
window.addAddon = function () {
  captureGlobals()
  let n = 1
  while (config.globals.addons['new' + n]) n++
  config.globals.addons['new' + n] = { label: 'New', type: 'flat_per_pc', amount: 0 }
  renderGlobals()
}
window.removeAddon = function (k) {
  captureGlobals()
  delete config.globals.addons[k]
  renderGlobals()
}

function saveGlobals() {
  captureGlobals()
  saveConfig().catch(e => toast(e.message, 'err'))
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKUPS TAB
// ─────────────────────────────────────────────────────────────────────────────
function initBackups() {
  document.getElementById('backup-create').addEventListener('click', createBackup)
  renderBackups()
}

async function renderBackups() {
  const list = document.getElementById('backup-list')
  list.innerHTML = '<div class="loader"><div class="spinner"></div> Loading backups…</div>'
  try {
    const backups = await api('GET', '/api/backups')
    if (!backups.length) {
      list.innerHTML = '<p style="color:var(--muted)">No backups yet.</p>'
      return
    }
    let html = `<table class="price-grid" style="font-size:13px">
      <thead><tr><th>Date</th><th>Label</th><th>ID</th><th style="text-align:center">Actions</th></tr></thead><tbody>`
    for (const b of backups) {
      const d = new Date(b.timestamp)
      const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString()
      const shortId = b.id.slice(0, 8)
      html += `<tr>
        <td>${dateStr}</td>
        <td>${b.label}</td>
        <td style="font-family:monospace;font-size:11px;color:var(--muted)" title="${b.id}">${shortId}…</td>
        <td style="text-align:center">
          <button class="btn-secondary btn-sm" onclick="restoreBackup('${b.id}')">Restore</button>
          <a class="btn-secondary btn-sm" href="/api/backup/${b.id}/download" style="text-decoration:none;display:inline-block">Download</a>
          <button class="btn-mini" onclick="deleteBackup('${b.id}')">Delete</button>
        </td>
      </tr>`
    }
    html += '</tbody></table>'
    list.innerHTML = html
  } catch (e) {
    list.innerHTML = `<p style="color:var(--danger)">${e.message}</p>`
  }
}

async function createBackup() {
  const label = document.getElementById('backup-label').value.trim() || 'Manual backup'
  try {
    await api('POST', '/api/backup', { label })
    document.getElementById('backup-label').value = ''
    toast('Backup created')
    renderBackups()
  } catch (e) { toast(e.message, 'err') }
}

window.restoreBackup = async function (id) {
  if (!confirm('Restore this backup? (current config will be backed up first)')) return
  try {
    const result = await api('POST', `/api/restore/${id}`)
    config = await api('GET', '/api/config')
    toast(`Restored: ${result.restored.label} (${new Date(result.restored.timestamp).toLocaleString()})`)
    renderBackups()
  } catch (e) { toast(e.message, 'err') }
}

window.deleteBackup = async function (id) {
  if (!confirm('Delete this backup permanently?')) return
  try {
    await api('DELETE', `/api/backup/${id}`)
    toast('Backup deleted')
    renderBackups()
  } catch (e) { toast(e.message, 'err') }
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot()
