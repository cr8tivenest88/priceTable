// ── State ─────────────────────────────────────────────────────────────────────
let config = {}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  config = await api('GET', '/api/config')
  initNav()
  initPriceTable()
  initProducts()
  initFinishings()
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
  toast('Config saved')
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
    })
  })
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.style.background = type === 'err' ? '#ef4444' : '#1e293b'
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 2500)
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE TABLE TAB
// ─────────────────────────────────────────────────────────────────────────────
let ptMode = 'all'

function initPriceTable() {
  const productSel = document.getElementById('pt-product')
  populateSelect(productSel, Object.entries(config.products).map(([k, v]) => ({ value: k, label: v.label })))

  productSel.addEventListener('change', () => { renderSpecSelectors(); updateComboCount() })
  document.getElementById('pt-markup').addEventListener('input', updateComboCount)
  document.getElementById('pt-generate').addEventListener('click', generatePriceTable)

  setPtMode('all')
}

function setPtMode(mode) {
  ptMode = mode
  document.getElementById('pt-mode-custom').className = mode === 'custom' ? 'btn-primary' : 'btn-secondary'
  document.getElementById('pt-mode-all').className    = mode === 'all'    ? 'btn-primary' : 'btn-secondary'
  document.getElementById('pt-specs').style.display   = mode === 'custom' ? '' : 'none'
  renderSpecSelectors()
  updateComboCount()
}

function updateComboCount() {
  const productKey = document.getElementById('pt-product').value
  const product    = config.products[productKey]
  if (!product || ptMode !== 'all') { document.getElementById('pt-combo-count').textContent = ''; return }

  const specCounts   = Object.values(product.specs).map(s => Object.keys(s.options).length)
  const combos       = specCounts.reduce((a, b) => a * b, 1)
  const finishings   = product.allowed_finishings.length
  const qtys         = product.quantities.length
  const total        = combos * finishings * qtys
  document.getElementById('pt-combo-count').textContent =
    `${combos} spec combos × ${finishings} finishings × ${qtys} qty tiers = ${total} rows`
}

function renderSpecSelectors() {
  const productKey = document.getElementById('pt-product').value
  const product    = config.products[productKey]
  const container  = document.getElementById('pt-specs')
  container.innerHTML = ''

  if (!product || ptMode !== 'custom') return

  for (const [specKey, specDef] of Object.entries(product.specs)) {
    const field = document.createElement('div')
    field.className = 'field'
    field.innerHTML = `<label>${specDef.label}</label>`

    const sel = document.createElement('select')
    sel.id = `pt-spec-${specKey}`
    for (const [optKey, optDef] of Object.entries(specDef.options)) {
      const o = document.createElement('option')
      o.value = optKey
      o.textContent = optDef.label
      sel.appendChild(o)
    }
    field.appendChild(sel)
    container.appendChild(field)
  }
}

async function generatePriceTable() {
  const productKey = document.getElementById('pt-product').value
  const markup     = parseFloat(document.getElementById('pt-markup').value) || 0

  try {
    if (ptMode === 'all') {
      document.getElementById('pt-generate').textContent = 'Generating...'
      const rows = await api('POST', '/api/all-combos', { product: productKey, markup })
      renderAllCombosTable(rows)
    } else {
      const product = config.products[productKey]
      const specs = {}
      for (const specKey of Object.keys(product.specs)) {
        specs[specKey] = document.getElementById(`pt-spec-${specKey}`).value
      }
      const table = await api('POST', '/api/price-table', { product: productKey, specs, markup })
      renderPriceTable(table, productKey, markup)
    }
  } catch (e) {
    toast(e.message, 'err')
  } finally {
    document.getElementById('pt-generate').textContent = 'Generate Price Table'
  }
}

function renderPriceTable(table, productKey, markup) {
  const finishingKeys = Object.keys(table[0].finishings)
  const result = document.getElementById('pt-result')

  // Build two views: sell price table + cost breakdown
  let html = `
    <div class="tab-switcher">
      <button class="tab-btn active" onclick="switchView('sell', this)">Sell Price</button>
      <button class="tab-btn" onclick="switchView('unit', this)">Unit Price</button>
      <button class="tab-btn" onclick="switchView('cost', this)">Cost Breakdown</button>
    </div>
  `

  // ── Sell price table ──
  html += `<div id="view-sell" class="price-table-wrap">`
  html += `<table><thead><tr><th>QTY</th>`
  for (const fk of finishingKeys) {
    html += `<th>${config.finishings[fk].label}</th>`
  }
  html += `</tr></thead><tbody>`
  for (const row of table) {
    html += `<tr><td><strong>${row.qty} units</strong></td>`
    for (const fk of finishingKeys) {
      const p = row.finishings[fk]
      html += `<td><span class="sell">$${p.sellPrice}</span><br><span class="unit">$${p.unitSellPrice}/unit</span></td>`
    }
    html += `</tr>`
  }
  html += `</tbody></table></div>`

  // ── Unit price table ──
  html += `<div id="view-unit" class="price-table-wrap" style="display:none">`
  html += `<table><thead><tr><th>QTY</th>`
  for (const fk of finishingKeys) {
    html += `<th>${config.finishings[fk].label}</th>`
  }
  html += `</tr></thead><tbody>`
  for (const row of table) {
    html += `<tr><td><strong>${row.qty} units</strong></td>`
    for (const fk of finishingKeys) {
      const p = row.finishings[fk]
      html += `<td class="sell">$${p.unitSellPrice}</td>`
    }
    html += `</tr>`
  }
  html += `</tbody></table></div>`

  // ── Cost breakdown (per finishing) ──
  html += `<div id="view-cost" style="display:none">`
  for (const fk of finishingKeys) {
    html += `<h3>${config.finishings[fk].label} <span class="badge badge-blue">${markup}% markup</span></h3>`
    html += `<div class="price-table-wrap"><table>
      <thead><tr>
        <th>QTY</th>
        <th>Base Cost</th>
        <th>Addon Cost</th>
        <th>Finish Cost</th>
        <th>Total Cost</th>
        <th>Sell Price</th>
        <th>Unit Sell</th>
      </tr></thead><tbody>`
    for (const row of table) {
      const p = row.finishings[fk]
      html += `<tr>
        <td><strong>${p.qty}</strong></td>
        <td class="cost">$${p.baseCost}</td>
        <td class="cost">$${p.addonCost}</td>
        <td class="cost">$${p.finishCost}</td>
        <td class="cost"><strong>$${p.totalCost}</strong></td>
        <td class="sell">$${p.sellPrice}</td>
        <td class="sell">$${p.unitSellPrice}</td>
      </tr>`
    }
    html += `</tbody></table></div>`
  }
  html += `</div>`

  result.innerHTML = html
}

function renderAllCombosTable(rows) {
  const result     = document.getElementById('pt-result')
  if (!rows.length) { result.innerHTML = '<p>No rows generated.</p>'; return }

  const productKey    = document.getElementById('pt-product').value
  const productCfg    = config.products[productKey]
  const specKeys      = Object.keys(rows[0].specs)
  const finishingKeys = [...new Set(rows.map(r => r.finishing))]
  const qtyValues     = [...new Set(rows.map(r => r.qty))]
  const specOptions   = {}
  for (const sk of specKeys) specOptions[sk] = [...new Set(rows.map(r => r.specs[sk]))]

  const specLabel = sk => productCfg?.specs[sk]?.label ?? sk
  const optLabel  = (sk, v) => productCfg?.specs[sk]?.options[v]?.label ?? v

  function buildFilters(total) {
    let html = `<div class="combo-filters card"><div class="form-row" style="margin:0;flex-wrap:wrap;gap:12px;align-items:flex-end">`
    for (const sk of specKeys) {
      html += `<div class="field" style="min-width:140px">
        <label>${specLabel(sk)}</label>
        <select id="cf-${sk}" onchange="applyComboFilters()">
          <option value="">All</option>
          ${specOptions[sk].map(v => `<option value="${v}">${optLabel(sk, v)}</option>`).join('')}
        </select>
      </div>`
    }
    html += `
      <div class="field" style="min-width:140px">
        <label>Finishing</label>
        <select id="cf-finishing" onchange="applyComboFilters()">
          <option value="">All</option>
          ${finishingKeys.map(f => `<option value="${f}">${config.finishings[f]?.label ?? f}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="min-width:100px">
        <label>Qty</label>
        <select id="cf-qty" onchange="applyComboFilters()">
          <option value="">All</option>
          ${qtyValues.map(q => `<option value="${q}">${q}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <span id="cf-count" style="font-size:12px;color:var(--muted);padding:8px 0">${total} rows</span>
      </div>`
    html += `</div></div>`
    return html
  }

  window._allComboRows     = rows
  window._allComboSpecKeys = specKeys
  result.innerHTML = buildFilters(rows.length) + `<div id="combo-table">${buildComboTable(rows, specKeys)}</div>`
}

function buildComboTable(data, specKeys) {
  const productKey = document.getElementById('pt-product').value
  const productCfg = config.products[productKey]
  const specLabel  = sk => productCfg?.specs[sk]?.label ?? sk
  const optLabel   = (sk, v) => productCfg?.specs[sk]?.options[v]?.label ?? v

  if (!data.length) return `<p style="color:var(--muted);padding:16px">No rows match the filters.</p>`

  let html = `<div class="price-table-wrap"><table><thead><tr>`
  for (const sk of specKeys) html += `<th>${specLabel(sk)}</th>`
  html += `<th>Finishing</th><th>Qty</th><th>Base Cost</th><th>Addon Cost</th><th>Surcharge</th><th>Finish Cost</th><th>Total Cost</th><th>Sell Price</th><th>Unit Sell</th></tr></thead><tbody>`

  for (const r of data) {
    html += `<tr>`
    for (const sk of specKeys) html += `<td style="font-size:12px">${optLabel(sk, r.specs[sk])}</td>`
    html += `
      <td><span class="badge badge-blue">${r.finishingLabel}</span></td>
      <td><strong>${r.qty}</strong></td>
      <td class="cost">$${r.baseCost}</td>
      <td class="cost">$${r.addonCost}</td>
      <td class="cost">$${r.surchargeCost ?? 0}</td>
      <td class="cost">$${r.finishCost}</td>
      <td class="cost"><strong>$${r.totalCost}</strong></td>
      <td class="sell">$${r.sellPrice}</td>
      <td class="sell">$${r.unitSellPrice}</td>
    </tr>`
  }
  return html + `</tbody></table></div>`
}

window.applyComboFilters = function () {
  const rows     = window._allComboRows || []
  const specKeys = window._allComboSpecKeys || Object.keys(rows[0]?.specs || {})
  let filtered   = rows

  for (const sk of specKeys) {
    const val = document.getElementById(`cf-${sk}`)?.value
    if (val) filtered = filtered.filter(r => r.specs[sk] === val)
  }
  const fin = document.getElementById('cf-finishing')?.value
  if (fin) filtered = filtered.filter(r => r.finishing === fin)
  const qty = document.getElementById('cf-qty')?.value
  if (qty) filtered = filtered.filter(r => String(r.qty) === qty)

  document.getElementById('cf-count').textContent = `${filtered.length} rows`
  document.getElementById('combo-table').innerHTML = buildComboTable(filtered, specKeys)
}

function switchView(view, btn) {
  document.querySelectorAll('#pt-result .tab-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  document.getElementById('view-sell').style.display = view === 'sell' ? '' : 'none'
  document.getElementById('view-unit').style.display = view === 'unit' ? '' : 'none'
  document.getElementById('view-cost').style.display = view === 'cost' ? '' : 'none'
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTS TAB
// ─────────────────────────────────────────────────────────────────────────────
let currentProdKey = null

function initProducts() {
  renderProductList()

  document.getElementById('prod-new').addEventListener('click', newProduct)
  document.getElementById('prod-add-spec').addEventListener('click', addSpecGroup)
  document.getElementById('prod-save').addEventListener('click', saveProduct)
  document.getElementById('prod-delete').addEventListener('click', deleteProduct)

  // Inner tabs
  document.querySelectorAll('.inner-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.inner-tab').forEach(b => b.classList.remove('active'))
      document.querySelectorAll('.inner-tab-content').forEach(c => c.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`itab-${btn.dataset.itab}`).classList.add('active')
    })
  })
}

function renderProductList() {
  const list = document.getElementById('prod-list')
  list.innerHTML = ''
  for (const [key, prod] of Object.entries(config.products)) {
    const li = document.createElement('li')
    li.dataset.key = key
    li.innerHTML = `
      <span class="list-label">${prod.label}</span>
      <span class="list-sub">${prod.quantities.length} qty tiers · ${prod.allowed_finishings.length} finishings</span>
    `
    li.addEventListener('click', () => openProduct(key))
    list.appendChild(li)
  }
}

function openProduct(key) {
  currentProdKey = key
  const prod = config.products[key]

  // Highlight list item
  document.querySelectorAll('#prod-list li').forEach(li => li.classList.toggle('active', li.dataset.key === key))

  document.getElementById('prod-editor-title').textContent = prod.label
  document.getElementById('prod-editor-sub').textContent   = `key: ${key}`
  document.getElementById('prod-key').value        = key
  document.getElementById('prod-label').value      = prod.label
  document.getElementById('prod-quantities').value = prod.quantities.join(', ')

  renderSpecsList(prod.specs || {})
  renderFinishingCheckboxes(prod.allowed_finishings || [])

  document.getElementById('prod-empty').style.display  = 'none'
  document.getElementById('prod-editor').style.display = 'flex'

  // Reset to basics tab
  document.querySelectorAll('.inner-tab').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.inner-tab-content').forEach(c => c.classList.remove('active'))
  document.querySelector('.inner-tab[data-itab="basics"]').classList.add('active')
  document.getElementById('itab-basics').classList.add('active')
}

function newProduct() {
  currentProdKey = null
  document.querySelectorAll('#prod-list li').forEach(li => li.classList.remove('active'))

  document.getElementById('prod-editor-title').textContent = 'New Product'
  document.getElementById('prod-editor-sub').textContent   = ''
  document.getElementById('prod-key').value        = ''
  document.getElementById('prod-label').value      = ''
  document.getElementById('prod-quantities').value = '25, 50, 100, 250, 500, 1000'

  renderSpecsList({})
  renderFinishingCheckboxes([])

  document.getElementById('prod-empty').style.display  = 'none'
  document.getElementById('prod-editor').style.display = 'flex'
}

// ── Spec groups ───────────────────────────────────────────────────────────────
function renderSpecsList(specs) {
  const container = document.getElementById('prod-specs-list')
  container.innerHTML = ''
  for (const [specKey, specDef] of Object.entries(specs)) {
    container.appendChild(buildSpecGroupEl(specKey, specDef))
  }
}

function addSpecGroup() {
  document.getElementById('prod-specs-list').appendChild(buildSpecGroupEl('', { label: '', options: {} }))
}

function buildSpecGroupEl(specKey, specDef) {
  const wrap = document.createElement('div')
  wrap.className = 'spec-group'

  wrap.innerHTML = `
    <div class="spec-group-header">
      <div class="form-row" style="margin:0;flex:1;gap:12px">
        <div class="field">
          <label>Group Key <span class="hint">e.g. material</span></label>
          <input class="sg-key" type="text" value="${specKey}" placeholder="material" />
        </div>
        <div class="field">
          <label>Display Label</label>
          <input class="sg-label" type="text" value="${specDef.label || ''}" placeholder="Material" />
        </div>
      </div>
      <button class="btn-icon" title="Remove group" onclick="this.closest('.spec-group').remove()">🗑</button>
    </div>
    <div class="spec-group-body">
      <table class="spec-options-table">
        <thead>
          <tr>
            <th>Option Key</th>
            <th>Label</th>
            <th>Type</th>
            <th>Cost Fields</th>
            <th></th>
          </tr>
        </thead>
        <tbody class="sg-options"></tbody>
      </table>
      <button class="btn-secondary sg-add-opt">+ Add Option</button>
    </div>
  `

  const tbody = wrap.querySelector('.sg-options')
  for (const [optKey, optDef] of Object.entries(specDef.options || {})) {
    tbody.appendChild(buildOptionRow(optKey, optDef))
  }

  wrap.querySelector('.sg-add-opt').addEventListener('click', () => {
    tbody.appendChild(buildOptionRow('', {}))
  })

  return wrap
}

function buildOptionRow(optKey, optDef) {
  const tr = document.createElement('tr')
  const isBase = optDef.setup_cost !== undefined

  tr.innerHTML = `
    <td><input class="opt-key" type="text" value="${optKey}" placeholder="14pt-matte" style="width:110px" /></td>
    <td><input class="opt-label" type="text" value="${optDef.label || ''}" placeholder="14pt Matte" style="width:140px" /></td>
    <td>
      <select class="opt-type" style="width:130px">
        <option value="modifier" ${!isBase ? 'selected' : ''}>Modifier</option>
        <option value="base" ${isBase ? 'selected' : ''}>Base (curve)</option>
        <option value="surcharge" ${optDef.surcharge_pct !== undefined ? 'selected' : ''}>Surcharge %</option>
      </select>
    </td>
    <td class="opt-fields"></td>
    <td><button class="btn-icon" onclick="this.closest('tr').remove()">✕</button></td>
  `

  const fieldsEl = tr.querySelector('.opt-fields')
  const typeEl   = tr.querySelector('.opt-type')

  function renderFields() {
    if (typeEl.value === 'base') {
      fieldsEl.innerHTML = `
        <div class="base-fields">
          <div class="field"><label>Setup $</label><input class="opt-setup" type="number" step="0.01" value="${optDef.setup_cost ?? 8}" /></div>
          <div class="field"><label>Per Unit $</label><input class="opt-perunit" type="number" step="0.001" value="${optDef.per_unit_cost ?? 0.028}" /></div>
          <div class="field">
            <label>Scale <button class="info-btn" type="button" onclick="openScaleModal()">?</button></label>
            <input class="opt-scale" type="number" step="0.05" min="0.40" max="1.00" value="${optDef.scale_factor ?? 0.65}" />
          </div>
        </div>
      `
    } else if (typeEl.value === 'surcharge') {
      fieldsEl.innerHTML = `
        <div class="field"><label>Surcharge %</label><input class="opt-surcharge" type="number" step="0.5" min="0" value="${optDef.surcharge_pct ?? 10}" style="width:90px" /></div>
      `
    } else {
      fieldsEl.innerHTML = `
        <div class="field"><label>$ / unit add-on</label><input class="opt-modifier" type="number" step="0.001" value="${optDef.cost_modifier ?? 0}" style="width:90px" /></div>
      `
    }
  }

  typeEl.addEventListener('change', renderFields)
  renderFields()
  return tr
}

function renderFinishingCheckboxes(selected) {
  const container = document.getElementById('prod-finishings-check')
  container.innerHTML = ''
  for (const [fk, fv] of Object.entries(config.finishings)) {
    const lbl = document.createElement('label')
    lbl.innerHTML = `<input type="checkbox" value="${fk}" ${selected.includes(fk) ? 'checked' : ''} /> ${fv.label}`
    container.appendChild(lbl)
  }
}

// ── Save / Delete ─────────────────────────────────────────────────────────────
function saveProduct() {
  const newKey = document.getElementById('prod-key').value.trim()
  if (!newKey) { toast('Product key is required', 'err'); return }

  const quantities = document.getElementById('prod-quantities').value
    .split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))

  const specs = {}
  document.querySelectorAll('#prod-specs-list .spec-group').forEach(sg => {
    const specKey   = sg.querySelector('.sg-key').value.trim()
    const specLabel = sg.querySelector('.sg-label').value.trim()
    if (!specKey) return

    const options = {}
    sg.querySelectorAll('.sg-options tr').forEach(tr => {
      const optKey   = tr.querySelector('.opt-key').value.trim()
      const optLabel = tr.querySelector('.opt-label').value.trim()
      const type     = tr.querySelector('.opt-type').value
      if (!optKey) return

      options[optKey] = type === 'base' ? {
        label:         optLabel,
        setup_cost:    parseFloat(tr.querySelector('.opt-setup').value),
        per_unit_cost: parseFloat(tr.querySelector('.opt-perunit').value),
        scale_factor:  parseFloat(tr.querySelector('.opt-scale').value),
      } : type === 'surcharge' ? {
        label:        optLabel,
        surcharge_pct: parseFloat(tr.querySelector('.opt-surcharge').value),
      } : {
        label:         optLabel,
        cost_modifier: parseFloat(tr.querySelector('.opt-modifier').value),
      }
    })

    specs[specKey] = { label: specLabel, options }
  })

  const allowed_finishings = [...document.querySelectorAll('#prod-finishings-check input:checked')].map(i => i.value)

  if (currentProdKey && currentProdKey !== newKey) delete config.products[currentProdKey]

  config.products[newKey] = {
    label: document.getElementById('prod-label').value.trim(),
    quantities,
    specs,
    allowed_finishings,
  }

  saveConfig().then(() => {
    currentProdKey = newKey
    renderProductList()
    document.querySelectorAll('#prod-list li').forEach(li => li.classList.toggle('active', li.dataset.key === newKey))
    document.getElementById('prod-editor-title').textContent = config.products[newKey].label
    document.getElementById('prod-editor-sub').textContent   = `key: ${newKey}`
    populateSelect(document.getElementById('pt-product'),
      Object.entries(config.products).map(([k, v]) => ({ value: k, label: v.label })))
    renderSpecSelectors()
  })
}

function deleteProduct() {
  if (!currentProdKey || !confirm(`Delete "${currentProdKey}"?`)) return
  delete config.products[currentProdKey]
  currentProdKey = null
  saveConfig().then(() => {
    renderProductList()
    document.getElementById('prod-editor').style.display = 'none'
    document.getElementById('prod-empty').style.display  = 'flex'
  })
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
    { value: '', label: '— select a finishing —' },
    ...Object.entries(config.finishings).map(([k, v]) => ({ value: k, label: v.label }))
  ])
  document.getElementById('fin-editor').style.display = 'none'
}

function loadFinishing() {
  const key = document.getElementById('fin-select').value
  if (!key) { document.getElementById('fin-editor').style.display = 'none'; return }

  const fin = config.finishings[key]
  document.getElementById('fin-key').value      = key
  document.getElementById('fin-label').value    = fin.label
  document.getElementById('fin-flat').value     = fin.flat
  document.getElementById('fin-per-unit').value = fin.per_unit
  document.getElementById('fin-editor').style.display = 'block'
}

function newFinishing() {
  document.getElementById('fin-select').value = ''
  document.getElementById('fin-key').value      = ''
  document.getElementById('fin-label').value    = ''
  document.getElementById('fin-flat').value     = '0'
  document.getElementById('fin-per-unit').value = '0'
  document.getElementById('fin-editor').style.display = 'block'
}

function saveFinishing() {
  const oldKey = document.getElementById('fin-select').value
  const newKey = document.getElementById('fin-key').value.trim()
  if (!newKey) { toast('Finishing key is required', 'err'); return }

  if (oldKey && oldKey !== newKey) delete config.finishings[oldKey]

  config.finishings[newKey] = {
    label:    document.getElementById('fin-label').value.trim(),
    flat:     parseFloat(document.getElementById('fin-flat').value),
    per_unit: parseFloat(document.getElementById('fin-per-unit').value),
  }

  saveConfig().then(() => {
    refreshFinishingSelect()
    document.getElementById('fin-select').value = newKey
    loadFinishing()
    renderFinishingCheckboxes(
      config.products[document.getElementById('prod-select').value]?.allowed_finishings || []
    )
  })
}

function deleteFinishing() {
  const key = document.getElementById('fin-select').value
  if (!key || !confirm(`Delete finishing "${key}"?`)) return
  delete config.finishings[key]
  saveConfig().then(() => refreshFinishingSelect())
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function populateSelect(sel, items) {
  sel.innerHTML = ''
  for (const item of items) {
    const o = document.createElement('option')
    o.value = item.value
    o.textContent = item.label
    sel.appendChild(o)
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot()

// ─────────────────────────────────────────────────────────────────────────────
// SCALE FACTOR MODAL
// ─────────────────────────────────────────────────────────────────────────────
function openScaleModal() {
  updateScalePreview(0.65)
  document.getElementById('scale-slider').value = 0.65
  document.getElementById('scale-modal-overlay').classList.add('open')
}

function closeScaleModal() {
  document.getElementById('scale-modal-overlay').classList.remove('open')
}

function updateScalePreview(scale) {
  scale = parseFloat(scale)
  document.getElementById('scale-val-display').textContent = scale.toFixed(2)
  document.getElementById('scale-slider').value = scale

  const setup    = 8
  const perUnit  = 0.028
  const qtys     = [25, 50, 100, 250, 500, 1000]
  const tbody    = document.getElementById('scale-preview-rows')

  tbody.innerHTML = qtys.map(qty => {
    const cost     = setup + perUnit * Math.pow(qty, scale)
    const unitCost = cost / qty
    return `<tr>
      <td>${qty}</td>
      <td>$${cost.toFixed(2)}</td>
      <td style="color:var(--accent);font-weight:600">$${unitCost.toFixed(4)}</td>
    </tr>`
  }).join('')
}

// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeScaleModal()
})
