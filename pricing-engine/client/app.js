// ── State ─────────────────────────────────────────────────────────────────────
let config = {}
let lfConfig = { products: {} }
let currentProdKey = null
let currentLfKey   = null

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
  tshirts: {
    shirt_size: [
      { key: 'small',    label: 'Small' },
      { key: 'medium',   label: 'Medium' },
      { key: 'large',    label: 'Large' },
      { key: 'x_large',  label: 'X-Large' },
      { key: '2x_large', label: '2X-Large' },
    ],
    sides: [
      { key: 'single', label: 'Single Side (Front or Back)' },
      { key: 'double', label: 'Both Sides (Front + Back)' },
    ],
  },
}

// Products that render with the pivoted variant-column layout (one mini-table
// per turnaround per size, variants as columns, thickness × qty as rows).
function isPivotVariantProduct(prod) {
  return prod && (prod.lookup_keys || []).join(',') === 'thickness,size,variant'
}

// Products with the t-shirt shape: 4-axis lookup (art_size × color × shirt_size
// × sides) and turnaround-specific prices stored on each entry.
function isTshirtProduct(prod) {
  return prod && prod.prices_include_turnaround &&
    (prod.lookup_keys || []).join(',') === 'art_size,color,shirt_size,sides'
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  config   = await api('GET', '/api/config')
  lfConfig = await api('GET', '/api/largeformat-config')
  initNav()
  initPriceTable()
  initPrices()
  initProducts()
  initLargeFormat()
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
  // Products without a `size` lookup key (e.g. tshirts uses `art_size`) hide
  // the size dropdown entirely — the renderer iterates all art_sizes instead.
  const hasSize = (prod.lookup_keys || []).includes('size') || prod.mode === 'ncr'
  const sizes = (prod.options && prod.options.size) || uniqueKeyValues(prod, 'size')
  const sizeField = document.getElementById('pt-size-field')
  if (hasSize) {
    populateSelect(document.getElementById('pt-size'), sizes.map(s => ({ value: s, label: s })))
    sizeField.style.display = ''
  } else {
    sizeField.style.display = 'none'
  }

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
  const sizeCountLabel = hasSize ? `${sizes.length} sizes · ` : ''
  document.getElementById('pt-info').textContent = `${sizeCountLabel}${comboCount} combo rows · ${allowedTn.length} turnaround${allowedTn.length === 1 ? '' : 's'}`
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
    const hasSize = (prod.lookup_keys || []).includes('size') || prod.mode === 'ncr'

    // Single server call — engine returns rows with a byTurnaround map already populated
    const all = await api('POST', '/api/all-combos-multi', { product: key, markup, sides })
    let merged = hasSize && size ? all.filter(r => r.specs.size === size) : all
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

  // T-shirts: colors as rows, shirt_size × sides as columns, one mini table
  // per (art_size × turnaround).
  if (isTshirtProduct(prod)) {
    return renderTshirtPriceTable(prod, rows, markup, turnarounds)
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

// T-shirt price table: rows = colors, cols = shirt_size × sides, one table
// per (art_size × turnaround). The `sides` UI dropdown isn't used here — the
// sides axis is shown as sub-columns under each shirt_size header instead.
function renderTshirtPriceTable(prod, rows, markup, turnarounds) {
  if (!rows.length) {
    return `<h2 style="margin:20px 0 10px;font-size:18px">${prod.label}</h2>
      <p style="color:var(--muted);padding:16px">No prices yet. Fill them in under the Prices tab.</p>`
  }

  const colors     = prod.options?.color      || []
  const shirtSizes = prod.options?.shirt_size || []
  const artSizes   = prod.options?.art_size   || []
  const sideOpts   = prod.options?.sides      || []
  const lbl = o => typeof o === 'object' ? o.label : o
  const kOf = o => typeof o === 'object' ? o.key   : o
  const tnLabel = t => config.globals.turnaround[t]?.label || t

  // map[art_size][color][shirt_size][sides][turnaround] = { sellPrice, unitSellPrice }
  const map = {}
  for (const r of rows) {
    const a  = r.specs.art_size
    const c  = r.specs.color
    const ss = r.specs.shirt_size
    const sd = r.specs.sides
    for (const tn of turnarounds) {
      const p = r.byTurnaround?.[tn]
      if (!p) continue
      ;((((map[a] = map[a] || {})[c] = map[a][c] || {})[ss] = map[a][c][ss] || {})[sd] = map[a][c][ss][sd] || {})[tn] = p
    }
  }

  let html = `<h2 style="margin:20px 0 10px;font-size:18px">
    ${prod.label}
    <span style="color:var(--muted);font-size:12px;font-weight:400">${markup}% markup</span>
  </h2>`

  for (const a of artSizes) {
    // Which sides actually have data for this art_size?
    const presentSides = sideOpts.filter(s =>
      colors.some(c => shirtSizes.some(ss => map[a]?.[kOf(c)]?.[kOf(ss)]?.[kOf(s)]))
    )
    if (!presentSides.length) continue

    for (const tn of turnarounds) {
      html += `<h3 style="margin:18px 0 8px;font-size:14px;color:var(--accent)">
        ${prod.label} ${a} — ${tnLabel(tn)}
      </h3>`
      html += `<div class="card" style="padding:0;overflow:hidden;margin-bottom:12px"><div class="price-table-wrap"><table>
        <thead>
          <tr>
            <th rowspan="2">Product Name</th>
            <th rowspan="2">Art Size</th>
            <th rowspan="2">Colour</th>
            ${shirtSizes.map(ss => `<th colspan="${presentSides.length}">${lbl(ss)}</th>`).join('')}
          </tr>
          <tr>
            ${shirtSizes.map(() => presentSides.map(s => `<th style="font-weight:500;font-size:11px">${lbl(s)}</th>`).join('')).join('')}
          </tr>
        </thead>
        <tbody>`

      for (const c of colors) {
        html += `<tr>
          <td style="color:var(--muted);font-size:12px">${prod.label}</td>
          <td>${a}</td>
          <td class="row-key">${lbl(c)}</td>`
        for (const ss of shirtSizes) {
          for (const s of presentSides) {
            const cell = map[a]?.[kOf(c)]?.[kOf(ss)]?.[kOf(s)]?.[tn]
            html += cell
              ? `<td><span class="sell">$${cell.sellPrice}</span></td>`
              : `<td style="color:var(--muted)">—</td>`
          }
        }
        html += `</tr>`
      }
      html += `</tbody></table></div></div>`
    }
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

const PRODUCT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#06b6d4', '#84cc16',
]

function initPrices() {
  const bar = document.getElementById('pr-product-bar')
  bar.innerHTML = ''
  const entries = Object.entries(config.products)
  entries.forEach(([k, v], i) => {
    const btn = document.createElement('button')
    btn.className = 'prod-btn'
    btn.textContent = v.label
    btn.dataset.key = k
    btn.style.background = PRODUCT_COLORS[i % PRODUCT_COLORS.length]
    btn.addEventListener('click', () => selectPricesProduct(k))
    bar.appendChild(btn)
  })
  document.getElementById('pr-save').addEventListener('click', savePrices)
  if (entries.length) selectPricesProduct(entries[0][0])
}

function selectPricesProduct(key) {
  pricesProdKey = key
  document.querySelectorAll('#pr-product-bar .prod-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.key === key))
  renderPricesGrid()
}

function renderPricesGrid() {
  const prod = config.products[pricesProdKey]
  const grid = document.getElementById('pr-grid')
  if (!prod) { grid.innerHTML = ''; return }

  if (prod.mode === 'ncr') {
    grid.innerHTML = renderNcrPrices(prod)
    return
  }

  if (isPivotVariantProduct(prod)) {
    grid.innerHTML = renderCoroplastPrices(prod)
    return
  }

  if (isTshirtProduct(prod)) {
    grid.innerHTML = renderTshirtPrices(prod)
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

// NCR Prices editor: editable mirror of editorNcr's two tables (marginal
// per size + setup matrix). Uses data-pr-ncr-* attributes so it doesn't
// collide with the Products-tab editor's identical-shape inputs.
function renderNcrPrices(prod) {
  const sizes    = prod.options?.size || []
  const variants = prod.options?.variant || []
  const labelOf  = v => typeof v === 'object' ? v.label : v
  const keyOf    = v => typeof v === 'object' ? v.key   : v

  if (!sizes.length) return '<p style="color:var(--muted);padding:16px">No sizes yet — add some in the Products tab.</p>'
  if (!variants.length) return '<p style="color:var(--muted);padding:16px">No variants yet — add some in the Products tab.</p>'

  let html = `<h3 style="margin:24px 0 8px;font-size:16px;border-bottom:2px solid var(--accent);padding-bottom:6px">
    ${prod.label} — Marginal Cost per Book
  </h3>
  <p style="font-size:12px;color:var(--muted);margin:0 0 6px">Per-book variable cost. Same across variants of that size.</p>
  <div class="card" style="padding:0;overflow:hidden;margin-bottom:16px"><div class="price-table-wrap">
    <table class="price-grid">
      <thead><tr><th>Size</th><th>$ / book</th></tr></thead>
      <tbody>
        ${sizes.map(s => `
          <tr>
            <td class="row-key">${s}</td>
            <td><input type="number" step="0.01" data-pr-ncr-marginal="${escapeAttr(s)}" value="${prod.marginal_per_book?.[s] ?? ''}" /></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div></div>`

  html += `<h3 style="margin:24px 0 8px;font-size:16px;border-bottom:2px solid var(--accent);padding-bottom:6px">
    ${prod.label} — Setup Cost by Variant × Size
  </h3>
  <p style="font-size:12px;color:var(--muted);margin:0 0 6px">Per-job fixed cost: plate, ink, carbonless parts, etc.</p>
  <div class="card" style="padding:0;overflow:hidden;margin-bottom:16px"><div class="price-table-wrap">
    <table class="price-grid">
      <thead><tr><th>Variant</th>${sizes.map(s => `<th>${s}</th>`).join('')}</tr></thead>
      <tbody>
        ${variants.map(v => {
          const vKey = keyOf(v)
          return `<tr>
            <td class="row-key">${labelOf(v)}</td>
            ${sizes.map(s => `<td><input type="number" step="0.01" data-pr-ncr-setup-size="${escapeAttr(s)}" data-pr-ncr-setup-variant="${escapeAttr(vKey)}" value="${prod.setup?.[s]?.[vKey] ?? ''}" /></td>`).join('')}
          </tr>`
        }).join('')}
      </tbody>
    </table>
  </div></div>`

  return html
}

// T-shirt Prices editor: editable mirror of renderTshirtPriceTable — one
// mini-table per (art_size × turnaround), rows = colours, cols = shirt_size ×
// sides. Each cell edits entry.prices[1] (regular) or sameday_prices[1].
function renderTshirtPrices(prod) {
  const colors     = prod.options?.color      || []
  const shirtSizes = prod.options?.shirt_size || []
  const artSizes   = prod.options?.art_size   || []
  const sideOpts   = prod.options?.sides      || []
  const lbl = o => typeof o === 'object' ? o.label : o
  const kOf = o => typeof o === 'object' ? o.key   : o

  const findIdx = (a, c, ss, sd) => (prod.price_table || []).findIndex(e =>
    e.key.art_size === a && e.key.color === c && e.key.shirt_size === ss && e.key.sides === sd)

  let html = ''
  for (const a of artSizes) {
    const presentSides = sideOpts.filter(s =>
      colors.some(c => shirtSizes.some(ss => findIdx(a, kOf(c), kOf(ss), kOf(s)) >= 0))
    )
    if (!presentSides.length) continue

    for (const tn of ['regular', 'sameday']) {
      const tnLabel = tn === 'regular' ? 'Regular' : 'Same Day'
      html += `<h3 style="margin:24px 0 8px;font-size:16px;border-bottom:2px solid var(--accent);padding-bottom:6px">
        ${prod.label} ${a} — ${tnLabel}
      </h3>`
      html += `<div class="card" style="padding:0;overflow:hidden;margin-bottom:16px"><div class="price-table-wrap"><table class="price-grid">
        <thead>
          <tr>
            <th rowspan="2">Colour</th>
            ${shirtSizes.map(ss => `<th colspan="${presentSides.length}">${lbl(ss)}</th>`).join('')}
          </tr>
          <tr>
            ${shirtSizes.map(() => presentSides.map(s => `<th style="font-weight:500;font-size:11px">${lbl(s)}</th>`).join('')).join('')}
          </tr>
        </thead>
        <tbody>`
      for (const c of colors) {
        html += `<tr><td class="row-key">${lbl(c)}</td>`
        for (const ss of shirtSizes) {
          for (const s of presentSides) {
            const idx = findIdx(a, kOf(c), kOf(ss), kOf(s))
            const entry = idx >= 0 ? prod.price_table[idx] : null
            const mapKey = tn === 'regular' ? 'prices' : 'sameday_prices'
            const val = entry?.[mapKey]?.[1] ?? ''
            html += idx >= 0
              ? `<td><input type="number" step="0.01" data-ts-idx="${idx}" data-ts-tn="${tn}" value="${val}" /></td>`
              : `<td style="color:var(--muted)">—</td>`
          }
        }
        html += `</tr>`
      }
      html += `</tbody></table></div></div>`
    }
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
  // NCR inputs: marginal per size + setup per (size, variant)
  if (prod.mode === 'ncr') {
    prod.marginal_per_book = prod.marginal_per_book || {}
    prod.setup = prod.setup || {}
    document.querySelectorAll('#pr-grid input[data-pr-ncr-marginal]').forEach(inp => {
      const s = inp.dataset.prNcrMarginal
      const v = inp.value === '' ? null : parseFloat(inp.value)
      if (v == null) delete prod.marginal_per_book[s]
      else if (!isNaN(v)) prod.marginal_per_book[s] = v
    })
    document.querySelectorAll('#pr-grid input[data-pr-ncr-setup-size]').forEach(inp => {
      const s = inp.dataset.prNcrSetupSize
      const k = inp.dataset.prNcrSetupVariant
      const v = inp.value === '' ? null : parseFloat(inp.value)
      prod.setup[s] = prod.setup[s] || {}
      if (v == null) delete prod.setup[s][k]
      else if (!isNaN(v)) prod.setup[s][k] = v
    })
  }
  // T-shirt inputs: idx + turnaround → prices[1] or sameday_prices[1]
  document.querySelectorAll('#pr-grid input[data-ts-idx]').forEach(inp => {
    const idx = parseInt(inp.dataset.tsIdx)
    const tn  = inp.dataset.tsTn
    const v   = inp.value === '' ? null : parseFloat(inp.value)
    const entry = prod.price_table?.[idx]
    if (!entry) return
    const mapKey = tn === 'regular' ? 'prices' : 'sameday_prices'
    if (!entry[mapKey]) entry[mapKey] = {}
    if (v == null) delete entry[mapKey][1]
    else           entry[mapKey][1] = v
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

  // Size chip management — only shown for products that actually have `size`
  // as a lookup key. Products like tshirts use art_size instead and handle
  // that via the generic per-key chip list below. Coroplast / foamcore have
  // sheet_imposition and manage sizes there.
  const hasSizeKey = (prod.lookup_keys || []).includes('size')
  if (hasSizeKey && !prod.sheet_imposition) {
    html += `<div class="editor-section">
      <h3>Sizes</h3>
      <div class="chip-list">
        ${(prod.options.size || []).map(s => `<span class="chip">${s}<button onclick="renameLookupValue('size','${escapeAttr(s)}')" title="Rename" style="color:var(--accent)">✎</button><button onclick="removeLookupValue('size','${escapeAttr(s)}')" title="Remove">✕</button></span>`).join('')}
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
        ${opts.map(v => `<span class="chip">${labelOf(v)}<button onclick="renameLookupValue('${k}','${escapeAttr(keyOf(v))}')" title="Rename" style="color:var(--accent)">✎</button><button onclick="removeLookupValue('${k}','${escapeAttr(keyOf(v))}')" title="Remove">✕</button></span>`).join('')}
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

// Rename an existing option without losing the prices already entered for it.
//   - String options ("100lb Gloss Text"):  rename the string everywhere,
//     and rewrite every price_table[i].key[keyName] that matched the old value.
//   - Object options ({key, label}):  only rename the .label (the .key stays,
//     so price_table rows are untouched).
window.renameLookupValue = function (keyName, currentKey) {
  const prod = config.products[currentProdKey]
  const opts = prod.options[keyName] || []
  const idx  = opts.findIndex(v => (typeof v === 'object' ? v.key : v) === currentKey ||
                                   String(typeof v === 'object' ? v.key : v) === String(currentKey))
  if (idx === -1) { toast(`Couldn't find "${currentKey}"`, 'err'); return }

  const isObject = typeof opts[idx] === 'object'
  const currentLabel = isObject ? opts[idx].label : opts[idx]
  const next = prompt(isObject ? 'New label:' : 'New name:', currentLabel)
  if (next == null) return
  const trimmed = next.trim()
  if (!trimmed || trimmed === currentLabel) return

  if (isObject) {
    // Just a display rename — key (and therefore price_table rows) untouched
    opts[idx].label = trimmed
  } else {
    // String rename — must also update every price_table row that keyed by it
    const norm = s => String(s).trim().toLowerCase()
    if (opts.some((v, i) => i !== idx && norm(typeof v === 'object' ? v.key : v) === norm(trimmed))) {
      toast(`"${trimmed}" already exists`, 'err'); return
    }
    opts[idx] = trimmed
    let updated = 0
    for (const row of (prod.price_table || [])) {
      if (String(row.key?.[keyName]) === String(currentKey)) {
        row.key[keyName] = trimmed
        updated++
      }
    }
    toast(`Renamed — updated ${updated} price row${updated === 1 ? '' : 's'}`)
  }
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
  renderFinishings()
  document.getElementById('finishings-save').addEventListener('click', saveFinishings)
}

function renderFinishings() {
  const body = document.getElementById('finishings-body')
  let html = `<div class="global-block">
    <table class="price-grid">
      <thead>
        <tr>
          <th>Key</th>
          <th>Label</th>
          <th>Flat Cost ($)</th>
          <th>Per Unit ($)</th>
          <th></th>
        </tr>
      </thead>
      <tbody>`
  for (const [k, v] of Object.entries(config.globals.finishings)) {
    html += `<tr>
      <td><input data-fin-key="${k}" data-field="key"      value="${k}" /></td>
      <td><input data-fin-key="${k}" data-field="label"    value="${v.label}" /></td>
      <td><input data-fin-key="${k}" data-field="flat"     type="number" step="0.01"  min="0" value="${v.flat}" /></td>
      <td><input data-fin-key="${k}" data-field="per_unit" type="number" step="0.001" min="0" value="${v.per_unit}" /></td>
      <td><button class="btn-mini" onclick="removeFinishing('${k}')">✕</button></td>
    </tr>`
  }
  html += `</tbody></table>
    <button class="btn-secondary" style="margin-top:8px" onclick="addFinishing()">+ Add Finishing</button>
  </div>`
  body.innerHTML = html
}

function captureFinishings() {
  const fin = {}
  document.querySelectorAll('#finishings-body tbody tr').forEach(tr => {
    const inputs = tr.querySelectorAll('input')
    const key = inputs[0].value.trim()
    if (!key) return
    fin[key] = {
      label:    inputs[1].value.trim(),
      flat:     parseFloat(inputs[2].value) || 0,
      per_unit: parseFloat(inputs[3].value) || 0,
    }
  })
  if (Object.keys(fin).length) config.globals.finishings = fin
}

window.addFinishing = function () {
  captureFinishings()
  let n = 1
  while (config.globals.finishings['new' + n]) n++
  config.globals.finishings['new' + n] = { label: 'New Finishing', flat: 0, per_unit: 0 }
  renderFinishings()
}

window.removeFinishing = function (k) {
  captureFinishings()
  delete config.globals.finishings[k]
  renderFinishings()
}

function saveFinishings() {
  captureFinishings()
  saveConfig().then(() => {
    renderFinishings()
    if (currentProdKey) openProduct(currentProdKey)
  }).catch(e => toast(e.message, 'err'))
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
    config   = await api('GET', '/api/config')
    lfConfig = await api('GET', '/api/largeformat-config')
    renderLargeFormatList()
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

// ─────────────────────────────────────────────────────────────────────────────
// LARGE FORMAT TAB — sqft-based products with {sizeName,width,height} sizes,
// {label,material_name,sqftRangeCost} materials, and step-function rate tables.
// Data lives in config-largeformat.json (separate from the main config).
// ─────────────────────────────────────────────────────────────────────────────

function initLargeFormat() {
  renderLargeFormatList()
  document.getElementById('lf-save').addEventListener('click', saveLargeFormat)
  document.getElementById('lf-add-product').addEventListener('click', addLargeFormatProduct)
  document.getElementById('lf-duplicate').addEventListener('click', duplicateLargeFormatProduct)
}

function renderLargeFormatList() {
  const ul = document.getElementById('lf-list')
  ul.innerHTML = ''
  const entries = Object.entries(lfConfig.products || {})
  if (!entries.length) {
    ul.innerHTML = '<li style="padding:12px;color:var(--muted);font-size:12px">No products yet — click “+ New”.</li>'
    return
  }
  for (const [key, prod] of entries) {
    const li = document.createElement('li')
    li.dataset.key = key
    const matLabels = (prod.materials || []).map(m => m.label || m.material_name).filter(Boolean)
    const matList = matLabels.length
      ? `<ul class="lf-mat-sublist">${matLabels.map(l => `<li>${escapeAttr(l)}</li>`).join('')}</ul>`
      : `<span class="list-sub" style="font-style:italic">no materials yet</span>`
    li.innerHTML = `<span class="list-label">${escapeAttr(prod.label || key)}</span>${matList}`
    li.addEventListener('click', () => openLargeFormat(key))
    if (key === currentLfKey) li.classList.add('active')
    ul.appendChild(li)
  }
}

function openLargeFormat(key) {
  currentLfKey = key
  const prod = lfConfig.products[key]
  if (!prod) return
  document.querySelectorAll('#lf-list li').forEach(li => li.classList.toggle('active', li.dataset.key === key))
  document.getElementById('lf-editor-title').textContent = prod.label || key
  document.getElementById('lf-editor-sub').textContent   = `key: ${key} · sqft-based`
  document.getElementById('lf-empty').style.display = 'none'
  document.getElementById('lf-editor').style.display = 'flex'
  document.getElementById('lf-editor-body').innerHTML = editorLargeFormat(key, prod)
  wireLargeFormatEditor()
}

function editorLargeFormat(key, prod) {
  const sizes     = prod.sizes     || []
  const materials = prod.materials || []
  const tnKeys    = Object.keys(config.globals?.turnaround || {})
  const addonKeys = Object.keys(config.globals?.addons    || {})
  const tnList    = Array.isArray(prod.allowed_turnarounds) ? prod.allowed_turnarounds : tnKeys
  const adList    = Array.isArray(prod.allowed_addons)      ? prod.allowed_addons      : addonKeys

  let html = `<div class="card">`

  html += `<div class="note">
    <strong>Large Format — sqft-based pricing.</strong>
    <ul>
      <li><strong>Sizes</strong> are stored as <code>{sizeName, width, height}</code> in inches. Per-piece sqft = (w × h) ÷ 144.</li>
      <li><strong>Materials</strong> reference an <code>sqftRangeCost</code> key. Each row in that table is <code>{sqft, ratePerSqft}</code>.</li>
      <li><strong>Tier lookup</strong> is step-function: total sqft across the whole order picks the highest row where <code>row.sqft ≤ totalSqft</code>. Below the smallest row, the first row's rate is used.</li>
      <li>Turnarounds and add-ons come from the main Globals — tick which ones this product supports.</li>
    </ul>
  </div>`

  // ── Product label + key ────────────────────────────────────────────────────
  const savedMarkup = Number.isFinite(prod.markup) ? prod.markup : 0
  html += `<div class="editor-section">
    <h3>Product</h3>
    <div class="form-row">
      <div class="field">
        <label>Label</label>
        <input id="lf-label" value="${escapeAttr(prod.label || '')}" />
      </div>
      <div class="field">
        <label>Key</label>
        <input value="${escapeAttr(key)}" disabled />
      </div>
      <div class="field" style="flex:0 0 auto">
        <label>&nbsp;</label>
        <button class="btn-mini" onclick="deleteLargeFormatProduct('${escapeAttr(key)}')">Delete Product</button>
      </div>
    </div>
  </div>`

  // ── Sizes — compact aligned table ──────────────────────────────────────────
  html += `<div class="editor-section">
    <h3>Sizes <span style="font-weight:400;color:var(--muted);font-size:12px">· inches · click ✕ to remove</span></h3>
    <table class="price-grid" id="lf-sizes-list" style="max-width:340px;font-size:12px">
      <thead>
        <tr>
          <th style="text-align:left">Size</th>
          <th style="text-align:right">W × H (in)</th>
          <th style="text-align:right">sqft</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${sizes.map((s, i) => {
          const w = Number(s.width), h = Number(s.height)
          const sq = (w * h) / 144
          return `<tr>
            <td style="text-align:left;font-weight:600">${escapeAttr(s.sizeName || '')}</td>
            <td style="text-align:right;font-family:monospace;color:var(--muted)">${w} × ${h}</td>
            <td style="text-align:right;font-family:monospace">${sq.toFixed(2)}</td>
            <td style="text-align:center"><button class="btn-mini" onclick="removeLfSize(${i})" title="Remove">✕</button></td>
          </tr>`
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="background:#f8fafc">
          <td style="color:var(--muted);font-style:italic;font-size:11px">auto</td>
          <td style="text-align:right;white-space:nowrap">
            <input id="lf-add-size-w" type="number" step="0.01" min="0" placeholder="W" style="width:48px;padding:2px 4px;border:1px solid var(--border);border-radius:3px;font-size:12px;text-align:right" />
            <span style="color:var(--muted)">×</span>
            <input id="lf-add-size-h" type="number" step="0.01" min="0" placeholder="H" style="width:48px;padding:2px 4px;border:1px solid var(--border);border-radius:3px;font-size:12px;text-align:right" />
            <select id="lf-add-size-unit" style="padding:1px 2px;border:1px solid var(--border);border-radius:3px;font-size:11px">
              <option value="in">in</option>
              <option value="ft">ft</option>
            </select>
          </td>
          <td style="text-align:right;font-family:monospace;color:var(--muted)" id="lf-add-sqft-preview">—</td>
          <td style="text-align:center"><button class="btn-mini" style="background:var(--accent)" onclick="addLfSize()" title="Add size">+</button></td>
        </tr>
      </tfoot>
    </table>
    <p style="color:var(--muted);font-size:11px;margin:6px 0 0">Name auto-fills as <code>WxH</code> from the inch values.</p>
  </div>`

  // ── Quantities — chip list per product ────────────────────────────────────
  const qtys = Array.isArray(prod.quantities) ? prod.quantities.slice().sort((a, b) => a - b) : []
  html += `<div class="editor-section">
    <h3>Quantity Break Points <span style="font-weight:400;color:var(--muted);font-size:12px">· columns shown in preview &amp; export</span></h3>
    <div class="chip-list" id="lf-qty-chips">
      ${qtys.length ? qtys.map(q => `<span class="chip">${q}<button onclick="removeLfQty(${q})" title="Remove">✕</button></span>`).join('')
        : '<span style="color:var(--muted);font-size:12px;font-style:italic">No quantities yet — using defaults [1, 2, 5, 10, 25, 50, 100, 250, 500]</span>'}
    </div>
    <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
      <input id="lf-add-qty" type="number" min="1" placeholder="e.g. 100" style="width:120px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px" />
      <button class="btn-secondary btn-sm" onclick="addLfQty()">+ Add</button>
      <button class="btn-secondary btn-sm" onclick="resetLfQtys()" title="Restore the defaults">↺ Reset to defaults</button>
    </div>
  </div>`

  // ── Materials + their rate tables — one card per material, side-by-side ────
  html += `<div class="editor-section">
    <h3>Materials &amp; Pricing
      <button class="btn-secondary btn-sm" style="margin-left:12px" onclick="previewLfXlsx()" ${materials.length === 0 ? 'disabled' : ''}>👁 Preview All</button>
      <button class="btn-secondary btn-sm" onclick="exportLfXlsx()" ${materials.length === 0 ? 'disabled' : ''}>⬇ Export All (.xlsx)</button>
    </h3>
    <p style="color:var(--muted);font-size:12px;margin:0 0 8px">
      Each material owns its own pricing table — strictly 1:1, no sharing. Step-function: total sqft picks the highest row where <code>row.sqft ≤ totalSqft</code>.
    </p>
    ${materials.length === 0 ? '<p style="color:var(--muted);font-size:12px">No materials yet — add one below.</p>' : ''}
    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start">
      ${materials.map((m, i) => renderMaterialCard(m, i)).join('')}
    </div>
    <div style="display:flex;gap:6px;margin-top:12px;align-items:center">
      <input id="lf-add-mat-label" placeholder="new material label (e.g. Matte Vinyl)" style="flex:1;max-width:300px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px" />
      <button class="btn-secondary btn-sm" onclick="addLfMaterial()">+ Add Material</button>
      <span style="color:var(--muted);font-size:11px"><code>material_name</code> auto-fills from label</span>
    </div>
  </div>`

  // ── Allowed turnarounds / add-ons ──────────────────────────────────────────
  html += `<div class="editor-section">
    <h3>Available Turnarounds
      <button class="btn-secondary btn-sm" style="margin-left:12px" onclick="toggleAllChecks('lf-turnarounds', true)">All</button>
      <button class="btn-secondary btn-sm" onclick="toggleAllChecks('lf-turnarounds', false)">None</button>
    </h3>
    <div class="checkbox-grid" id="lf-turnarounds">
      ${tnKeys.map(k =>
        `<label><input type="checkbox" value="${escapeAttr(k)}" ${tnList.includes(k) ? 'checked' : ''}/> ${escapeAttr(config.globals.turnaround[k].label)} <span style="color:var(--muted);font-size:11px">×${config.globals.turnaround[k].multiplier}</span></label>`).join('')}
    </div>
  </div>`

  html += `<div class="editor-section">
    <h3>Available Add-ons
      <button class="btn-secondary btn-sm" style="margin-left:12px" onclick="toggleAllChecks('lf-addons', true)">All</button>
      <button class="btn-secondary btn-sm" onclick="toggleAllChecks('lf-addons', false)">None</button>
    </h3>
    <p style="color:var(--muted);font-size:11px;margin:0 0 6px">Tick the add-ons this product offers. Pricing comes from the main Globals tab — shown here for reference.</p>
    <div class="checkbox-grid" id="lf-addons">
      ${addonKeys.map(k => {
        const a = config.globals.addons[k]
        return `<label title="${escapeAttr(k)}"><input type="checkbox" value="${escapeAttr(k)}" ${adList.includes(k) ? 'checked' : ''}/> ${escapeAttr(a.label)} <span style="color:var(--muted);font-size:11px">· ${formatAddonAmount(a)}</span></label>`
      }).join('')}
    </div>
  </div>`

  // ── Markup — single source for preview, export, AND test ──────────────────
  html += `<div class="editor-section">
    <h3>Markup</h3>
    <div class="form-row">
      <div class="field" style="max-width:200px">
        <label>Markup % <span style="color:var(--muted);font-weight:400">· used by preview, export &amp; test</span></label>
        <input id="lf-markup" type="number" min="0" step="0.5" value="${savedMarkup}" />
      </div>
    </div>
    <p style="color:var(--muted);font-size:11px;margin:6px 0 0">Save the product after changing this so preview/export pick it up.</p>
  </div>`

  // ── Test-price panel ───────────────────────────────────────────────────────
  // Allowed addons (after the Available Add-ons block has been resolved above)
  // are auto-included in the test, ticked by default. Untick any you want to
  // exclude from a particular quote.
  html += `<div class="editor-section">
    <h3>Test Price</h3>
    <div class="form-row">
      <div class="field">
        <label>Size</label>
        <select id="lf-test-size">
          ${sizes.map(s => `<option value="${escapeAttr(s.sizeName)}">${escapeAttr(s.sizeName)} (${((Number(s.width)*Number(s.height))/144).toFixed(2)} sqft)</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Material</label>
        <select id="lf-test-material">
          ${materials.map(m => `<option value="${escapeAttr(m.material_name)}">${escapeAttr(m.label || m.material_name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Qty</label>
        <input id="lf-test-qty" type="number" min="1" value="10" />
      </div>
      <div class="field">
        <label>Turnaround</label>
        <select id="lf-test-turnaround">
          ${tnKeys.map(k => `<option value="${escapeAttr(k)}">${escapeAttr(config.globals.turnaround[k].label)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${adList.length ? `
      <div style="margin-top:8px">
        <label style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Add-ons (auto-included — untick to exclude)</label>
        <div class="checkbox-grid" id="lf-test-addons" style="margin-top:4px">
          ${adList.map(k => {
            const a = config.globals.addons[k]
            if (!a) return ''
            return `<label><input type="checkbox" value="${escapeAttr(k)}" checked /> ${escapeAttr(a.label)} <span style="color:var(--muted);font-size:11px">· ${formatAddonAmount(a)}</span></label>`
          }).join('')}
        </div>
      </div>` : ''}
    <div style="display:flex;gap:12px;align-items:center;margin-top:8px">
      <button class="btn-primary" onclick="runLfTestPrice()">Calculate</button>
      <span style="color:var(--muted);font-size:12px">Uses the currently-saved config — save first if you just edited rates.</span>
    </div>
    <div id="lf-test-result" style="margin-top:10px"></div>
  </div>`

  html += `</div>`
  return html
}

// Format an addon's pricing for inline display next to its label.
function formatAddonAmount(a) {
  if (!a) return ''
  if (a.type === 'flat')         return `+$${a.amount} flat`
  if (a.type === 'flat_per_pc')  return `+$${a.amount}/pc`
  if (a.type === 'pct_of_base')  return `+${a.amount}% of base`
  return ''
}

function renderMaterialCard(m, i) {
  const rates = m.rates || []
  return `<div class="key-block" data-mat-i="${i}" style="width:260px;margin-bottom:0;flex:0 0 auto">
    <div class="key-block-title" style="display:flex;justify-content:space-between;align-items:center;gap:6px">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(m.label || '')}">${escapeAttr(m.label || '(unnamed)')}</span>
      <button class="btn-mini" onclick="removeLfMaterial(${i})" title="Delete this material">✕</button>
    </div>
    <div style="font-size:10px;color:var(--muted);margin-bottom:6px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(m.material_name || '')}">${escapeAttr(m.material_name || '')}</div>
    <input data-mat-label value="${escapeAttr(m.label || '')}" placeholder="Label" style="width:100%;padding:3px 6px;border:1px solid var(--border);border-radius:3px;font-size:12px;margin-bottom:6px;box-sizing:border-box" />
    <table class="price-grid" data-mat-rates style="font-size:11px">
      <thead><tr><th>sqft</th><th>$/sqft</th><th></th></tr></thead>
      <tbody>
        ${rates.map((r, j) => `
          <tr data-j="${j}">
            <td><input data-rate-sqft  type="number" step="0.01"   min="0" value="${Number(r.sqft) || 0}"        style="width:60px" /></td>
            <td><input data-rate-price type="number" step="0.0001" min="0" value="${Number(r.ratePerSqft) || 0}" style="width:60px" /></td>
            <td><button class="btn-mini" onclick="removeLfRateRow(${i}, ${j})">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div style="display:flex;gap:4px;margin-top:6px">
      <button class="btn-secondary btn-sm" style="flex:1" onclick="addLfRateRow(${i})">+ Row</button>
      <button class="btn-secondary btn-sm" onclick="duplicateLfMaterial(${i})" title="Duplicate this material with its rate table">📋 Dup</button>
    </div>
    <div style="display:flex;gap:4px;margin-top:6px;border-top:1px solid var(--border);padding-top:6px">
      <button class="btn-secondary btn-sm" style="flex:1" onclick="previewLfXlsx('${escapeAttr(m.material_name)}')" title="Preview the price table in-page">👁 Preview</button>
      <button class="btn-secondary btn-sm" style="flex:1;background:var(--accent);color:#fff" onclick="exportLfXlsx('${escapeAttr(m.material_name)}')" title="Download .xlsx">⬇ Export</button>
    </div>
  </div>`
}

function wireLargeFormatEditor() {
  // Live sqft preview in the add-size footer row
  const wEl = document.getElementById('lf-add-size-w')
  const hEl = document.getElementById('lf-add-size-h')
  const uEl = document.getElementById('lf-add-size-unit')
  const out = document.getElementById('lf-add-sqft-preview')
  if (!wEl || !hEl || !uEl || !out) return
  const update = () => {
    let w = Number(wEl.value) || 0
    let h = Number(hEl.value) || 0
    if (uEl.value === 'ft') { w *= 12; h *= 12 }
    out.textContent = (w > 0 && h > 0) ? ((w * h) / 144).toFixed(2) : '—'
  }
  wEl.addEventListener('input', update)
  hEl.addEventListener('input', update)
  uEl.addEventListener('change', update)
}

// ── Mutations (sizes) ────────────────────────────────────────────────────────
window.addLfSize = function () {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  let w = Number(document.getElementById('lf-add-size-w').value) || 0
  let h = Number(document.getElementById('lf-add-size-h').value) || 0
  const unit = document.getElementById('lf-add-size-unit').value
  if (w <= 0 || h <= 0) { toast('Fill width and height', 'err'); return }
  if (unit === 'ft') { w *= 12; h *= 12 }
  // Auto-derive sizeName as "WxH" using the inch values (drop trailing .00)
  const fmt = n => Number.isInteger(n) ? String(n) : String(+n.toFixed(2))
  const name = `${fmt(w)}x${fmt(h)}`
  prod.sizes = prod.sizes || []
  captureLfSizeEdits()
  if (prod.sizes.some(s => s.sizeName === name)) { toast(`Duplicate size "${name}"`, 'err'); return }
  prod.sizes.push({ sizeName: name, width: w, height: h })
  openLargeFormat(currentLfKey)
}

window.removeLfSize = function (i) {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  captureLfSizeEdits()
  prod.sizes.splice(i, 1)
  openLargeFormat(currentLfKey)
}

function captureLfSizeEdits() {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  const tbl = document.getElementById('lf-sizes-table')
  if (!tbl || !prod) return
  const rows = tbl.querySelectorAll('tbody tr')
  const next = []
  rows.forEach(tr => {
    const name = tr.querySelector('[data-size-name]')?.value.trim()
    const w = Number(tr.querySelector('[data-size-w]')?.value) || 0
    const h = Number(tr.querySelector('[data-size-h]')?.value) || 0
    if (name) next.push({ sizeName: name, width: w, height: h })
  })
  prod.sizes = next
}

// ── Mutations (materials) ────────────────────────────────────────────────────
window.addLfMaterial = function () {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  const label = document.getElementById('lf-add-mat-label').value.trim()
  if (!label) { toast('Fill material label', 'err'); return }
  // Auto-derive material_name: lowercase, non-alphanum → underscore, collapse + trim
  const name = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!name) { toast('Label has no usable characters', 'err'); return }
  captureLfEdits()
  prod.materials = prod.materials || []
  if (prod.materials.some(m => m.material_name === name)) { toast(`Duplicate material "${name}"`, 'err'); return }
  // Strict 1:1 — rates live inline on the material with one starter row.
  prod.materials.push({ label, material_name: name, rates: [{ sqft: 1, ratePerSqft: 0 }] })
  openLargeFormat(currentLfKey)
}

window.removeLfMaterial = function (i) {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  if (!confirm(`Delete material "${prod.materials[i]?.label || ''}"? Its rate table goes with it.`)) return
  captureLfEdits()
  prod.materials.splice(i, 1)
  openLargeFormat(currentLfKey)
}

// Clone a material with its rate table — fastest way to add a new material
// when the rates are similar to an existing one (just tweak after).
window.duplicateLfMaterial = function (i) {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  const src = prod.materials?.[i]
  if (!src) return
  const newLabel = prompt('New material label:', `${src.label} (copy)`)
  if (!newLabel) return
  const trimmed = newLabel.trim()
  if (!trimmed) return
  const name = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!name) { toast('Label has no usable characters', 'err'); return }
  if (prod.materials.some(m => m.material_name === name)) { toast(`"${name}" already exists`, 'err'); return }
  captureLfEdits()
  prod.materials.push({
    label: trimmed,
    material_name: name,
    rates: (src.rates || []).map(r => ({ sqft: r.sqft, ratePerSqft: r.ratePerSqft })),
  })
  openLargeFormat(currentLfKey)
}

// ── Mutations (quantities) ──────────────────────────────────────────────────
window.addLfQty = function () {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  const v = parseInt(document.getElementById('lf-add-qty').value)
  if (!v || v < 1) { toast('Enter a positive integer', 'err'); return }
  captureLfEdits()
  prod.quantities = prod.quantities || []
  if (!prod.quantities.includes(v)) prod.quantities.push(v)
  prod.quantities.sort((a, b) => a - b)
  openLargeFormat(currentLfKey)
}

window.removeLfQty = function (q) {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  captureLfEdits()
  prod.quantities = (prod.quantities || []).filter(x => x !== q)
  openLargeFormat(currentLfKey)
}

window.resetLfQtys = function () {
  if (!currentLfKey) return
  if (!confirm('Reset to default break points [1, 2, 5, 10, 25, 50, 100, 250, 500]?')) return
  captureLfEdits()
  lfConfig.products[currentLfKey].quantities = [1, 2, 5, 10, 25, 50, 100, 250, 500]
  openLargeFormat(currentLfKey)
}

// ── Mutations (rate rows) ────────────────────────────────────────────────────
window.addLfRateRow = function (matIdx) {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  const m = prod.materials?.[matIdx]
  if (!m) return
  captureLfEdits()
  m.rates = m.rates || []
  m.rates.push({ sqft: 0, ratePerSqft: 0 })
  openLargeFormat(currentLfKey)
}

window.removeLfRateRow = function (matIdx, j) {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  const m = prod.materials?.[matIdx]
  if (!m) return
  captureLfEdits()
  m.rates.splice(j, 1)
  openLargeFormat(currentLfKey)
}

// Capture every in-flight edit from the current editor DOM into lfConfig
function captureLfEdits() {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  if (!prod) return
  const labelEl = document.getElementById('lf-label')
  if (labelEl) prod.label = labelEl.value.trim() || currentLfKey
  const markupEl = document.getElementById('lf-markup')
  if (markupEl) prod.markup = Math.max(0, Number(markupEl.value) || 0)
  captureLfSizeEdits()
  captureLfMaterialEdits()
  // allowed_* — empty list means "user explicitly unticked all"
  const ticked = id => [...document.querySelectorAll(`#${id} input:checked`)].map(i => i.value)
  prod.allowed_turnarounds = ticked('lf-turnarounds')
  prod.allowed_addons      = ticked('lf-addons')
}

// Reads label + rate rows from each material card back into the model
function captureLfMaterialEdits() {
  if (!currentLfKey) return
  const prod = lfConfig.products[currentLfKey]
  if (!prod) return
  document.querySelectorAll('[data-mat-i]').forEach(card => {
    const i = Number(card.dataset.matI)
    const m = prod.materials?.[i]
    if (!m) return
    const labelEl = card.querySelector('[data-mat-label]')
    if (labelEl) m.label = labelEl.value.trim() || m.label
    const rows = card.querySelectorAll('[data-mat-rates] tbody tr')
    const next = []
    rows.forEach(tr => {
      const s = Number(tr.querySelector('[data-rate-sqft]')?.value)
      const p = Number(tr.querySelector('[data-rate-price]')?.value)
      if (!isNaN(s) && !isNaN(p)) next.push({ sqft: s, ratePerSqft: p })
    })
    m.rates = next.sort((a, b) => a.sqft - b.sqft)
  })
}

// ── Product-level mutations ─────────────────────────────────────────────────
function addLargeFormatProduct() {
  const key = prompt('Product key (lowercase, no spaces — e.g. lf_canvas):')
  if (!key) return
  const clean = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (!clean) return
  if (lfConfig.products[clean]) { toast('Key already exists', 'err'); return }
  const label = prompt('Product label:', clean) || clean
  lfConfig.products[clean] = {
    label,
    sizes: [],
    materials: [],
    allowed_addons: null,
    allowed_turnarounds: null,
  }
  renderLargeFormatList()
  openLargeFormat(clean)
}

// Clone the current Large Format product as a new key — perfect for spinning
// up Canvas / Foamboard / Coroplast from the Banners template, then editing
// rates and material list as needed.
function duplicateLargeFormatProduct() {
  if (!currentLfKey) { toast('Pick a product to duplicate first', 'err'); return }
  const src = lfConfig.products[currentLfKey]
  if (!src) return
  const newKey = prompt('New product key (lowercase, no spaces — e.g. lf_canvas):', `${currentLfKey}_copy`)
  if (!newKey) return
  const cleanKey = newKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (!cleanKey) return
  if (lfConfig.products[cleanKey]) { toast(`Key "${cleanKey}" already exists`, 'err'); return }
  const newLabel = prompt('New product label:', `${src.label || currentLfKey} (copy)`) || cleanKey

  captureLfEdits()
  // Deep-clone via JSON round-trip — sizes/materials/rates/qtys/allowed_* all
  // simple JSON, no functions or refs to preserve.
  const clone = JSON.parse(JSON.stringify(src))
  clone.label = newLabel.trim() || cleanKey
  lfConfig.products[cleanKey] = clone
  renderLargeFormatList()
  openLargeFormat(cleanKey)
  toast(`Duplicated to "${cleanKey}" — review & save when ready`)
}

window.deleteLargeFormatProduct = function (key) {
  if (!confirm(`Delete Large Format product "${key}"? This cannot be undone (until you restore a backup).`)) return
  delete lfConfig.products[key]
  currentLfKey = null
  document.getElementById('lf-editor').style.display = 'none'
  document.getElementById('lf-empty').style.display = 'flex'
  renderLargeFormatList()
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function saveLargeFormat() {
  captureLfEdits()
  try {
    await api('PUT', '/api/largeformat-config', lfConfig)
    toast('Saved')
    renderLargeFormatList()
    if (currentLfKey) openLargeFormat(currentLfKey)
  } catch (e) {
    toast(e.message, 'err')
  }
}

// ── Test-price runner ───────────────────────────────────────────────────────
window.runLfTestPrice = async function () {
  if (!currentLfKey) return
  const addons = [...document.querySelectorAll('#lf-test-addons input:checked')].map(i => i.value)
  const base = {
    product:      currentLfKey,
    sizeName:     document.getElementById('lf-test-size').value,
    materialName: document.getElementById('lf-test-material').value,
    qty:          Number(document.getElementById('lf-test-qty').value) || 1,
    turnaround:   document.getElementById('lf-test-turnaround').value,
    markup:       Number(document.getElementById('lf-markup').value) || 0,
  }
  const out = document.getElementById('lf-test-result')
  out.innerHTML = '<p style="color:var(--muted);font-size:12px">Calculating…</p>'
  try {
    // Always run "no add-ons" so the user sees the original price as a baseline.
    // Run "with add-ons" too if any are ticked, so the delta is explicit.
    const reqs = [api('POST', '/api/largeformat-calculate', { ...base, addons: [] })]
    if (addons.length) reqs.push(api('POST', '/api/largeformat-calculate', { ...base, addons }))
    const [original, withAddons] = await Promise.all(reqs)
    out.innerHTML = renderLfTestResult(original, withAddons || null, addons)
  } catch (e) {
    out.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:6px;padding:10px;font-size:13px"><strong>Error:</strong> ${escapeAttr(e.message)}</div>`
  }
}

function renderLfTestResult(original, withAddons, addonKeys) {
  const r = original
  const matLabel = (lfConfig.products[currentLfKey]?.materials || [])
    .find(m => m.material_name === r.materialName)?.label || r.materialName
  const tnLabel  = config.globals?.turnaround?.[r.turnaround]?.label || r.turnaround
  const money    = n => `$${Number(n).toFixed(2)}`
  const sqft     = n => Number(n).toFixed(2)
  const addonLabels = (addonKeys || []).map(k => config.globals?.addons?.[k]?.label || k)

  // Step-function explanation (same rate row for both prices — addons don't change tier)
  const matObj = (lfConfig.products[currentLfKey]?.materials || [])
    .find(m => m.material_name === r.materialName)
  const rates = (matObj?.rates || []).slice().sort((a, b) => a.sqft - b.sqft)
  const tierExplain = rates.length
    ? `Total <strong>${sqft(r.totalSqft)} sqft</strong> falls in the <strong>$${r.ratePerSqft}/sqft</strong> tier (rates step at ${rates.map(x => x.sqft).join(', ')} sqft)`
    : ''

  // ── Two-price headline (base vs with-addons) ────────────────────────────────
  const delta = withAddons ? (withAddons.sellPrice - r.sellPrice) : 0
  const headline = `<div style="display:flex;gap:12px;margin-bottom:10px">
    <div style="flex:1;background:#fff;border:1px solid var(--border);border-radius:6px;padding:10px">
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Original (no add-ons)</div>
      <div style="font-size:22px;font-weight:700;color:var(--text);margin-top:4px">${money(r.sellPrice)}</div>
      <div style="color:var(--muted);font-size:11px">${money(r.unitSellPrice)} / piece</div>
    </div>
    ${withAddons ? `
    <div style="flex:1;background:#eff6ff;border:1px solid var(--accent);border-radius:6px;padding:10px">
      <div style="font-size:11px;color:var(--accent);text-transform:uppercase;letter-spacing:.5px">With add-ons</div>
      <div style="font-size:22px;font-weight:700;color:var(--accent);margin-top:4px">${money(withAddons.sellPrice)}
        <span style="font-size:12px;font-weight:500;color:#065f46">+${money(delta)}</span>
      </div>
      <div style="color:var(--muted);font-size:11px">${money(withAddons.unitSellPrice)} / piece</div>
      ${addonLabels.length ? `<div style="color:var(--muted);font-size:11px;margin-top:4px">${escapeAttr(addonLabels.join(', '))}</div>` : ''}
    </div>` : ''}
  </div>`

  // ── Side-by-side breakdown column(s) ───────────────────────────────────────
  const breakdown = (label, p, withAddonRow) => {
    const subtotal = p.baseCost + p.addonCost
    return `<div style="flex:1">
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">${label}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tbody>
          <tr><td style="padding:3px 0;color:var(--muted)">Base cost</td><td style="text-align:right;font-family:monospace">${money(p.baseCost)}</td></tr>
          ${withAddonRow ? `<tr><td style="padding:3px 0">+ Add-ons</td><td style="text-align:right;font-family:monospace">${money(p.addonCost)}</td></tr>` : ''}
          <tr><td style="padding:3px 0;color:var(--muted)">Subtotal</td><td style="text-align:right;font-family:monospace">${money(subtotal)}</td></tr>
          <tr><td style="padding:3px 0">× Turnaround (×${p.turnaroundMul})</td><td style="text-align:right;font-family:monospace">${money(p.totalCost)}</td></tr>
          <tr><td style="padding:3px 0">× Markup (${p.markup}%)</td><td style="text-align:right;font-family:monospace;font-weight:600">${money(p.sellPrice)}</td></tr>
        </tbody>
      </table>
    </div>`
  }

  return `<div style="background:#f8fafc;border:1px solid var(--border);border-radius:6px;padding:14px;font-size:13px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;border-bottom:1px solid var(--border);padding-bottom:8px">
      <div>
        <div style="font-weight:600">${escapeAttr(r.qty)} × ${escapeAttr(r.sizeName)} · ${escapeAttr(matLabel)}</div>
        <div style="color:var(--muted);font-size:11px">${escapeAttr(tnLabel)} · ${r.markup}% markup</div>
      </div>
      <div style="text-align:right;font-size:11px;color:var(--muted);font-family:monospace">
        ${sqft(r.perPieceSqft)} sqft/pc · ${sqft(r.totalSqft)} sqft total · ${money(r.ratePerSqft)}/sqft
      </div>
    </div>

    ${headline}

    <div style="display:flex;gap:16px;margin-top:6px">
      ${breakdown('Original', r, false)}
      ${withAddons ? breakdown('With add-ons', withAddons, true) : ''}
    </div>

    ${tierExplain ? `<p style="color:var(--muted);font-size:11px;margin:10px 0 0">${tierExplain}</p>` : ''}
  </div>`
}

// ── Preview the price table (HTML) before downloading ──────────────────────
window.previewLfXlsx = async function (materialName) {
  if (!currentLfKey) return
  // Auto-save so the preview reflects on-screen edits
  try {
    captureLfEdits()
    await api('PUT', '/api/largeformat-config', lfConfig)
  } catch (e) { toast(e.message, 'err'); return }

  const prod = lfConfig.products[currentLfKey]
  const payload = { product: currentLfKey, markup: Number(prod?.markup) || 0 }
  if (materialName) payload.material = materialName

  try {
    const data = await api('POST', '/api/largeformat-preview', payload)
    showLfPreviewModal(data, materialName, payload.markup)
  } catch (e) {
    toast(e.message, 'err')
  }
}

function showLfPreviewModal(data, materialName, markup) {
  const money = n => (n == null || n === '') ? '' : `$${Number(n).toFixed(2)}`
  // One section per material
  const sections = data.materials.map(mat => {
    const tnHeader  = mat.turnarounds.map(tn =>
      `<th colspan="${mat.qtys.length}" style="background:#e0e7ff">${escapeAttr(tn.label)}</th>`).join('')
    const qtyHeader = mat.turnarounds.map(() =>
      mat.qtys.map(q => `<th>Qty ${q}</th>`).join('')).join('')
    const variantCol = mat.hasVariants
      ? '<th rowspan="2" style="background:#f1f5f9">Variant</th>' : ''
    const body = mat.rows.map(r => {
      const cells = mat.turnarounds.map(tn =>
        mat.qtys.map(q => `<td style="text-align:right;font-family:monospace">${money(r.prices?.[tn.key]?.[q])}</td>`).join('')
      ).join('')
      const variantCell = mat.hasVariants
        ? `<td style="text-align:left;font-size:11px;padding-left:8px;${r.isBase ? 'color:var(--muted)' : 'background:#fef3c7;font-weight:600'}">${escapeAttr(r.variant || '')}</td>`
        : ''
      // Tint non-Base rows so add-on variants visually group with their Base
      const rowBg = r.isBase ? '' : 'background:#fffbeb'
      const sizeCell = r.isBase
        ? `<td style="text-align:left;font-weight:600" rowspan="${1 + (mat.variants.length - 1)}">${escapeAttr(r.size)}</td>
           <td style="text-align:right;font-family:monospace;color:var(--muted)" rowspan="${1 + (mat.variants.length - 1)}">${r.width} × ${r.height}</td>
           <td style="text-align:right;font-family:monospace" rowspan="${1 + (mat.variants.length - 1)}">${r.sqft}</td>`
        : ''
      return `<tr style="${rowBg}">
        ${mat.hasVariants ? sizeCell : `
          <td style="text-align:left;font-weight:600">${escapeAttr(r.size)}</td>
          <td style="text-align:right;font-family:monospace;color:var(--muted)">${r.width} × ${r.height}</td>
          <td style="text-align:right;font-family:monospace">${r.sqft}</td>`}
        ${variantCell}
        ${cells}
      </tr>`
    }).join('')

    return `<div style="margin-bottom:24px">
      <h3 style="margin:0 0 8px;font-size:14px">${escapeAttr(mat.materialLabel)} <span style="color:var(--muted);font-weight:400;font-size:11px">· ${escapeAttr(mat.material)}${mat.hasVariants ? ' · ' + (mat.variants.length - 1) + ' add-on variant' + (mat.variants.length === 2 ? '' : 's') : ''}</span></h3>
      <div style="overflow:auto;max-width:100%">
        <table class="price-grid" style="font-size:11px;min-width:max-content">
          <thead>
            <tr>
              <th rowspan="2" style="background:#f1f5f9">Size</th>
              <th rowspan="2" style="background:#f1f5f9">W × H (in)</th>
              <th rowspan="2" style="background:#f1f5f9">sqft / pc</th>
              ${variantCol}
              ${tnHeader}
            </tr>
            <tr>${qtyHeader}</tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`
  }).join('')

  const overlay = document.createElement('div')
  overlay.id = 'lf-preview-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px'
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:8px;max-width:95vw;max-height:95vh;display:flex;flex-direction:column;box-shadow:0 25px 50px rgba(0,0,0,.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-size:16px;font-weight:700">Preview · ${escapeAttr(data.productLabel)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">${data.materials.length} material${data.materials.length === 1 ? '' : 's'} · prices include all allowed turnarounds${markup ? ` · <strong style="color:var(--accent)">+${markup}% markup applied</strong>` : ' · <em>0% markup</em>'}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn-primary" onclick="exportLfXlsx(${materialName ? `'${escapeAttr(materialName)}'` : ''})">⬇ Download .xlsx</button>
          <button class="btn-secondary" onclick="closeLfPreview()">✕ Close</button>
        </div>
      </div>
      <div style="padding:20px;overflow:auto;flex:1">${sections}</div>
    </div>
  `
  // Close on background click or Escape
  overlay.addEventListener('click', e => { if (e.target === overlay) closeLfPreview() })
  document.addEventListener('keydown', lfPreviewKeyHandler)
  document.body.appendChild(overlay)
}

function lfPreviewKeyHandler(e) { if (e.key === 'Escape') closeLfPreview() }
window.closeLfPreview = function () {
  const o = document.getElementById('lf-preview-overlay')
  if (o) o.remove()
  document.removeEventListener('keydown', lfPreviewKeyHandler)
}

// ── Excel export — single material or all materials ────────────────────────
window.exportLfXlsx = async function (materialName) {
  if (!currentLfKey) return
  // Auto-save first so the export reflects whatever is currently on screen
  try {
    captureLfEdits()
    await api('PUT', '/api/largeformat-config', lfConfig)
  } catch (e) { toast(e.message, 'err'); return }

  const prod = lfConfig.products[currentLfKey]
  const payload = { product: currentLfKey, markup: Number(prod?.markup) || 0 }
  if (materialName) payload.material = materialName

  try {
    const res = await fetch('/api/largeformat-export-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error || res.statusText)
    }
    const blob = await res.blob()
    // Pull filename out of Content-Disposition; fall back to a sensible default
    let filename = `${currentLfKey}-${materialName || 'all'}.xlsx`
    const cd = res.headers.get('content-disposition') || ''
    const m = cd.match(/filename="([^"]+)"/)
    if (m) filename = m[1]
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast('Downloaded ' + filename)
  } catch (e) {
    toast(e.message, 'err')
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot()
