/**
 * Pricing Engine
 *
 * Two product modes:
 *
 *   "lookup"    — unit price is read from a price_table keyed by lookup_keys.
 *                 Quantity → unit price (or line total if price_is_line_total).
 *                 Quantities not in the table are linearly interpolated; out-of-
 *                 range quantities clamp to the nearest endpoint.
 *
 *   "coroplast" — parametric area/thickness model in engine-coroplast.js.
 *
 * Cost flow (lookup):
 *   unit_base   = interpolate(price_table[combo].prices, qty)
 *   base_cost   = unit_base × qty       (or = unit_base if price_is_line_total)
 *   + add-ons   (flat / per-pc / pct-of-base)
 *   + finishing (flat + per_unit × qty)
 *   × turnaround multiplier
 *   × (1 + markup / 100)
 *
 * Defaults: if a product omits allowed_addons / allowed_turnarounds /
 * allowed_finishings, ALL globals are assumed allowed.
 */

const fs   = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, 'config.json')
let _configCache = null
let _configMtime = 0

/**
 * Reads config.json with mtime-based caching. Re-reads only when the file
 * has changed on disk. Cuts ~1ms × thousands of calls per generation.
 *
 * Building the lookup index also lives here so it gets rebuilt when the
 * config changes.
 */
function loadConfig() {
  let mtime
  try { mtime = fs.statSync(CONFIG_PATH).mtimeMs } catch { mtime = 0 }
  if (_configCache && mtime === _configMtime) return _configCache
  _configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  _configMtime = mtime
  // Drop any indexes the previous load attached
  for (const p of Object.values(_configCache.products || {})) delete p._lookupIndex
  return _configCache
}

// ── Public API ───────────────────────────────────────────────────────────────

function calculatePrice(opts) {
  // Optional `_config` lets callers skip the disk read in hot loops.
  const config = opts._config || loadConfig()
  const productCfg = resolveProduct(config, opts.product)

  // Resolve unified `sides` field (1 or 2) into the per-product encoding so
  // the salesperson never has to know how each product family stores it.
  const resolved = resolveSides(productCfg, opts)

  if (productCfg.mode === 'lookup') return calcLookup(config, productCfg, resolved)
  if (productCfg.mode === 'ncr')    return calcNcr(config, productCfg, resolved)
  throw new Error(`Unknown mode "${productCfg.mode}" for product "${opts.product}"`)
}

/**
 * Map a unified `sides` (1|2) input into whatever each product actually uses:
 *   - flyer        → specs.sides = 'single' | 'double'
 *   - business_card→ swap variant base→double_sided, round_corner→ds_round_corner
 *   - brochure     → append 'double_sided' add-on for sides=2
 *   - coroplast    → pass-through (already uses sides)
 *   - booklets/ncr → ignored (always 2-sided / always 1-sided respectively)
 *
 * Returns a NEW opts object — does not mutate the caller's input.
 */
function resolveSides(productCfg, opts) {
  if (opts.sides == null) return opts                  // not specified → engine defaults
  const sides = Number(opts.sides)
  const next = { ...opts, specs: { ...(opts.specs || {}) }, addons: [...(opts.addons || [])] }

  const keys = productCfg.lookup_keys || []
  // Flyer-style: lookup key is `sides`
  if (keys.includes('sides')) {
    next.specs.sides = sides === 2 ? 'double' : 'single'
    return next
  }
  // Business-card style: lookup key is `variant` and there are double-sided variants
  if (keys.includes('variant')) {
    const v = String(next.specs.variant || '')
    if (sides === 2) {
      if (v === 'base')          next.specs.variant = 'double_sided'
      else if (v === 'round_corner') next.specs.variant = 'ds_round_corner'
    } else {
      if (v === 'double_sided')      next.specs.variant = 'base'
      else if (v === 'ds_round_corner') next.specs.variant = 'round_corner'
    }
    return next
  }
  // Generic: brochure and friends — apply the global double_sided add-on
  if (sides === 2 && !next.addons.some(a => (typeof a === 'string' ? a : a.key) === 'double_sided')) {
    next.addons.push('double_sided')
  }
  return next
}

function buildPriceTable({ product, specs = {}, addons = [], turnaround = 'regular', markup = 0 }) {
  const config = loadConfig()
  const productCfg = resolveProduct(config, product)
  const finishings = allowed(productCfg, 'finishings', config) || ['no_finish']
  return productCfg.quantities.map(qty => {
    const row = { qty, finishings: {} }
    for (const finishing of finishings) {
      row.finishings[finishing] = calculatePrice({ product, specs, addons, turnaround, finishing, qty, markup })
    }
    return row
  })
}

function generateAllCombos({ product, markup = 0, turnaround = 'regular', sides = null }) {
  const config = loadConfig()
  const productCfg = resolveProduct(config, product)
  if (productCfg.mode === 'lookup') return enumerateLookup(config, productCfg, { product, markup, turnaround, sides })
  if (productCfg.mode === 'ncr')    return enumerateNcr(config, productCfg, { product, markup, turnaround })
  return []
}

/**
 * Like generateAllCombos but returns one row per (combo × qty × finishing)
 * with a `byTurnaround` map of { sellPrice, unitSellPrice } for every allowed
 * turnaround. Computes the base+addons+finishing ONCE per combo and applies
 * each turnaround multiplier — much faster than calling generateAllCombos N
 * times when there are many turnarounds.
 */
function generateAllCombosMulti({ product, markup = 0, sides = null }) {
  const config = loadConfig()
  const productCfg = resolveProduct(config, product)

  const turnarounds = (productCfg.allowed_turnarounds && productCfg.allowed_turnarounds.length)
    ? productCfg.allowed_turnarounds
    : Object.keys(config.globals.turnaround || {})

  // Slow path: products that store turnaround-specific prices directly (e.g.
  // tshirts with a sameday_prices map) — the ratio trick below gives wrong
  // sameday values, so re-enumerate per turnaround and merge by combo key.
  if (productCfg.mode === 'lookup' && productCfg.prices_include_turnaround) {
    const perTn = {}
    for (const tn of turnarounds) {
      perTn[tn] = enumerateLookup(config, productCfg, { product, markup, turnaround: tn, sides, _config: config })
    }
    const keyOf = r => `${JSON.stringify(r.specs)}|${r.qty}|${r.finishing}`
    const base = perTn[turnarounds[0]] || []
    return base.map(r => {
      const byTurnaround = {}
      for (const tn of turnarounds) {
        const match = (perTn[tn] || []).find(x => keyOf(x) === keyOf(r))
        if (match) byTurnaround[tn] = { sellPrice: match.sellPrice, unitSellPrice: match.unitSellPrice }
      }
      return { specs: r.specs, qty: r.qty, finishing: r.finishing, byTurnaround }
    })
  }

  // Fast path: regular → sameday → etc. all scale from a single baseline.
  const baseRows = productCfg.mode === 'lookup'
    ? enumerateLookup(config, productCfg, { product, markup, turnaround: 'regular', sides, _config: config })
    : productCfg.mode === 'ncr'
    ? enumerateNcr(config, productCfg, { product, markup, turnaround: 'regular', _config: config })
    : []

  const tnMul = {}
  for (const tn of turnarounds) tnMul[tn] = config.globals?.turnaround?.[tn]?.multiplier ?? 1
  const regMul = config.globals?.turnaround?.regular?.multiplier ?? 1

  // For each base row, compute sell price for each turnaround by re-scaling
  // the cost subtotal. Subtotal = totalCost / regMul (regular's multiplier),
  // then sellPrice(tn) = subtotal × tnMul × (1 + markup/100).
  const markupMul = 1 + markup / 100
  return baseRows.map(r => {
    const subtotal = r.totalCost / regMul
    const byTurnaround = {}
    for (const tn of turnarounds) {
      const total = subtotal * tnMul[tn]
      const sell  = total * markupMul
      byTurnaround[tn] = {
        sellPrice:     round(sell),
        unitSellPrice: round(sell / r.qty),
      }
    }
    return {
      specs:     r.specs,
      qty:       r.qty,
      finishing: r.finishing,
      byTurnaround,
    }
  })
}

// ── Lookup mode ──────────────────────────────────────────────────────────────

function calcLookup(config, productCfg, { specs = {}, qty, addons = [], turnaround = 'regular', finishing = 'no_finish', markup = 0 }) {
  const entry = findLookupEntry(productCfg, specs)
  if (!entry) {
    throw new Error(`No price for ${JSON.stringify(specs)} (lookup keys: ${productCfg.lookup_keys.join(', ')})`)
  }

  // Turnaround-specific pricing: some products (e.g. tshirts) store sameday
  // prices directly on the entry rather than deriving them via a global
  // multiplier. When present for the requested turnaround, use that map and
  // skip the multiplier step so prices aren't double-applied.
  let priceMap = entry.prices
  let tnMul = turnaroundMultiplier(config, turnaround)
  if (turnaround === 'sameday' && entry.sameday_prices) {
    priceMap = entry.sameday_prices
    tnMul = 1
  }

  const unit = interpolatePrice(priceMap, qty)
  if (unit == null) {
    throw new Error(`No price points for product (lookup keys: ${productCfg.lookup_keys.join(', ')})`)
  }

  const baseCost  = productCfg.price_is_line_total ? unit : unit * qty
  const addonCost = applyAddons(config, productCfg, addons, qty, baseCost)
  const finCost   = finishingCost(config, finishing, qty)
  const subtotal  = baseCost + addonCost + finCost
  const totalCost = subtotal * tnMul
  const sellPrice = totalCost * (1 + markup / 100)

  return {
    qty,
    unitBase:      round(unit),
    baseCost:      round(baseCost),
    addonCost:     round(addonCost),
    finishCost:    round(finCost),
    turnaround,
    turnaroundMul: tnMul,
    finishing,
    totalCost:     round(totalCost),
    markup,
    sellPrice:     round(sellPrice),
    unitSellPrice: round(sellPrice / qty),
  }
}

/**
 * Linear interpolation between published qty break points; clamps outside range.
 */
function interpolatePrice(prices, qty) {
  const points = Object.entries(prices)
    .map(([q, p]) => [Number(q), Number(p)])
    .filter(([q, p]) => !isNaN(q) && !isNaN(p))
    .sort((a, b) => a[0] - b[0])
  if (!points.length) return null
  if (prices[qty] != null) return prices[qty]
  if (qty <= points[0][0])                 return points[0][1]
  if (qty >= points[points.length - 1][0]) return points[points.length - 1][1]
  for (let i = 0; i < points.length - 1; i++) {
    const [qa, pa] = points[i], [qb, pb] = points[i + 1]
    if (qty >= qa && qty <= qb) {
      const t = (qty - qa) / (qb - qa)
      return pa + (pb - pa) * t
    }
  }
  return points[points.length - 1][1]
}

/**
 * O(1) lookup-table access. Builds an index keyed by the joined lookup-key
 * values once per product, caches it on the productCfg, and reuses it on
 * every subsequent call. Invalidated automatically when loadConfig reloads
 * the file (the cache lives on the cached config object itself).
 */
function findLookupEntry(productCfg, specs) {
  if (!productCfg._lookupIndex) {
    const idx = new Map()
    for (const entry of productCfg.price_table || []) {
      const key = productCfg.lookup_keys.map(k => entry.key[k]).join('\u0001')
      idx.set(key, entry)
    }
    productCfg._lookupIndex = idx
  }
  const lookupKey = productCfg.lookup_keys.map(k => specs[k]).join('\u0001')
  return productCfg._lookupIndex.get(lookupKey)
}

function enumerateLookup(config, productCfg, { product, markup, turnaround, sides, _config }) {
  const rows = []
  const cfgRef = _config || config
  const finishings = allowed(productCfg, 'finishings', cfgRef) || ['no_finish']
  // When `sides` is set and the product encodes sides as a lookup key (flyer)
  // or variant (business card), we should only iterate the matching rows so
  // the table doesn't double-up on both single and double versions.
  const keys = productCfg.lookup_keys || []
  // Only apply sides filtering for products that encode sides in a lookup key
  // or use business-card-style variant names (base/double_sided/round_corner).
  // Products like coroplast have a `variant` key but with their own naming
  // (1_side, 2_sides, grommet_*) — sides filtering doesn't apply to them.
  const bcVariants = new Set(['base', 'double_sided', 'round_corner', 'ds_round_corner'])
  const isBcStyle = keys.includes('variant') &&
    (productCfg.options?.variant || []).some(v => bcVariants.has(typeof v === 'object' ? v.key : v))

  const filterRow = entry => {
    if (sides == null) return true
    if (keys.includes('sides')) {
      return entry.key.sides === (Number(sides) === 2 ? 'double' : 'single')
    }
    if (isBcStyle) {
      const v = entry.key.variant
      return Number(sides) === 2
        ? (v === 'double_sided' || v === 'ds_round_corner')
        : (v === 'base'         || v === 'round_corner')
    }
    return true
  }

  for (const entry of productCfg.price_table) {
    if (!filterRow(entry)) continue
    const comboLabel = productCfg.lookup_keys.map(k => `${k}: ${entry.key[k]}`).join(' · ')
    for (const finishing of finishings) {
      for (const qty of productCfg.quantities) {
        if (entry.prices[qty] == null) continue
        const price = calculatePrice({ product, specs: entry.key, finishing, qty, markup, turnaround, sides, _config: cfgRef })
        rows.push({ comboLabel, specs: entry.key, finishing, ...price })
      }
    }
  }
  return rows
}

// ── NCR mode ─ setup + slope, per (size, variant) ───────────────────────────
//
//   line_total = setup[size][variant] + marginal_per_book[size] × qty
//
// Add-ons / finishing / turnaround / markup are layered on top exactly the
// same way they are for lookup products.
function calcNcr(config, productCfg, { specs = {}, qty, addons = [], turnaround = 'regular', finishing = 'no_finish', markup = 0 }) {
  const size    = specs.size
  const variant = specs.variant
  if (!size || !variant) {
    throw new Error(`NCR requires specs.size and specs.variant — got ${JSON.stringify(specs)}`)
  }
  const setup = productCfg.setup?.[size]?.[variant]
  if (setup == null) throw new Error(`No NCR setup for ${size} / ${variant}`)
  const marginal = productCfg.marginal_per_book?.[size]
  if (marginal == null) throw new Error(`No NCR marginal_per_book for ${size}`)

  const baseCost  = setup + marginal * qty
  const addonCost = applyAddons(config, productCfg, addons, qty, baseCost)
  const finCost   = finishingCost(config, finishing, qty)
  const subtotal  = baseCost + addonCost + finCost
  const totalCost = subtotal * turnaroundMultiplier(config, turnaround)
  const sellPrice = totalCost * (1 + markup / 100)

  return {
    qty,
    setup:         round(setup),
    marginal:      round(marginal),
    unitBase:      round(baseCost / qty),
    baseCost:      round(baseCost),
    addonCost:     round(addonCost),
    finishCost:    round(finCost),
    turnaround,
    turnaroundMul: turnaroundMultiplier(config, turnaround),
    finishing,
    totalCost:     round(totalCost),
    markup,
    sellPrice:     round(sellPrice),
    unitSellPrice: round(sellPrice / qty),
  }
}

function enumerateNcr(config, productCfg, { product, markup, turnaround, _config }) {
  const rows = []
  const cfgRef = _config || config
  const finishings = allowed(productCfg, 'finishings', cfgRef) || ['no_finish']
  const sizes    = productCfg.options?.size || []
  const variants = (productCfg.options?.variant || []).map(v => typeof v === 'object' ? v.key : v)
  const qtys     = productCfg.quantities || []

  for (const size of sizes) {
    for (const variant of variants) {
      const specs = { size, variant }
      const comboLabel = `size: ${size} · variant: ${variant}`
      for (const finishing of finishings) {
        for (const qty of qtys) {
          try {
            const price = calculatePrice({ product, specs, finishing, qty, markup, turnaround, _config: cfgRef })
            rows.push({ comboLabel, specs, finishing, ...price })
          } catch { /* missing setup for this combo — skip */ }
        }
      }
    }
  }
  return rows
}

// ── Shared add-ons / turnaround / finishings ─────────────────────────────────

/**
 * Resolve "allowed" list for a global category. An explicit array (even empty)
 * is authoritative — empty means "user explicitly allowed nothing." Only when
 * the field is missing entirely do we fall back to the all-allowed default.
 */
function allowed(productCfg, category, config) {
  const explicit = productCfg[`allowed_${category}`]
  if (Array.isArray(explicit)) return explicit
  return Object.keys(config.globals?.[category] || {})
}

function applyAddons(config, productCfg, addons, qty, baseCost) {
  const allowedSet = new Set(allowed(productCfg, 'addons', config))
  let total = 0
  for (const a of addons) {
    const key   = typeof a === 'string' ? a : a.key
    const count = typeof a === 'string' ? qty : (a.count ?? qty)
    if (!allowedSet.has(key)) continue
    const def = config.globals.addons[key]
    if (!def) continue
    if (def.type === 'flat')             total += def.amount
    else if (def.type === 'flat_per_pc') total += def.amount * count
    else if (def.type === 'pct_of_base') total += baseCost * (def.amount / 100)
  }
  return total
}

function turnaroundMultiplier(config, key) {
  const t = config.globals?.turnaround?.[key]
  return t ? t.multiplier : 1
}

function finishingCost(config, key, qty) {
  const f = config.globals?.finishings?.[key]
  if (!f) return 0
  return f.flat + f.per_unit * qty
}

// ── Utilities ────────────────────────────────────────────────────────────────

function resolveProduct(config, key) {
  const p = config.products?.[key]
  if (!p) throw new Error(`Unknown product: ${key}`)
  return p
}

function round(n) { return Math.round(n * 100) / 100 }

module.exports = { calculatePrice, buildPriceTable, generateAllCombos, generateAllCombosMulti, loadConfig }
