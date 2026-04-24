/**
 * Large Format Pricing Engine
 *
 * Area-based pricing for banners, canvas, foamboard, coroplast, etc.
 *
 * Formula:
 *   perPieceSqft = (width × height) / 144         // width/height in inches
 *   totalSqft    = perPieceSqft × qty
 *   ratePerSqft  = step-function lookup on sqftRangeCost — largest row
 *                  where row.sqft ≤ totalSqft (clamps to first row if below)
 *   baseCost     = totalSqft × ratePerSqft
 *   + addons     (reuses main config.globals.addons via engine.js helpers)
 *   × turnaround multiplier
 *   × (1 + markup / 100)
 *
 * Data lives in config-largeformat.json (separate from config.json so
 * existing products aren't affected). Globals (addons, turnarounds) come
 * from config.json — no duplication.
 */

const fs   = require('fs')
const path = require('path')

const { loadConfig, applyAddons, turnaroundMultiplier, allowed, round } = require('./engine')

const LF_CONFIG_PATH = path.join(__dirname, 'config-largeformat.json')
let _lfCache = null
let _lfMtime = 0

function loadLargeFormatConfig() {
  let mtime
  try { mtime = fs.statSync(LF_CONFIG_PATH).mtimeMs } catch { mtime = 0 }
  if (_lfCache && mtime === _lfMtime) return _lfCache
  if (!fs.existsSync(LF_CONFIG_PATH)) {
    _lfCache = { products: {} }
  } else {
    _lfCache = JSON.parse(fs.readFileSync(LF_CONFIG_PATH, 'utf8'))
    migrateInlineRates(_lfCache)
  }
  _lfMtime = mtime
  return _lfCache
}

/**
 * Old shape: each material had `sqftRangeCost: <key>` pointing into a top-level
 * `sqftRangeCost: { <key>: { rates: [...] } }` map (allowed sharing).
 * New shape: rates live inline on the material (strict 1:1, no sharing).
 * This folds old configs into the new shape on load. The next save flushes
 * the migrated structure to disk; the top-level map is dropped.
 */
function migrateInlineRates(lf) {
  if (!lf.sqftRangeCost) return
  for (const prod of Object.values(lf.products || {})) {
    for (const m of (prod.materials || [])) {
      if (Array.isArray(m.rates)) continue                  // already migrated
      const key = m.sqftRangeCost
      const src = key && lf.sqftRangeCost[key]
      m.rates = (src && Array.isArray(src.rates)) ? src.rates : []
      delete m.sqftRangeCost
    }
  }
  delete lf.sqftRangeCost
}

function calculateLargeFormat(opts) {
  const {
    product,
    sizeName,
    materialName,
    qty,
    addons = [],
    turnaround = 'regular',
    markup = 0,
  } = opts || {}

  if (!product)      throw new Error('product is required')
  if (!sizeName)     throw new Error('sizeName is required')
  if (!materialName) throw new Error('materialName is required')
  if (!qty || qty < 1) throw new Error('qty must be ≥ 1')

  const lf         = loadLargeFormatConfig()
  const mainConfig = loadConfig()

  const productCfg = lf.products?.[product]
  if (!productCfg) throw new Error(`Unknown Large Format product: ${product}`)

  const size = (productCfg.sizes || []).find(s => s.sizeName === sizeName)
  if (!size) throw new Error(`Unknown size "${sizeName}" for ${product}`)

  const material = (productCfg.materials || []).find(m => m.material_name === materialName)
  if (!material) throw new Error(`Unknown material "${materialName}" for ${product}`)

  const rates = [...(material.rates || [])]
    .map(r => ({ sqft: Number(r.sqft), ratePerSqft: Number(r.ratePerSqft) }))
    .filter(r => !isNaN(r.sqft) && !isNaN(r.ratePerSqft))
    .sort((a, b) => a.sqft - b.sqft)
  if (!rates.length) throw new Error(`Material "${materialName}" has no rate rows`)

  const perPieceSqft = (Number(size.width) * Number(size.height)) / 144
  const totalSqft    = perPieceSqft * qty

  // Step-function: largest row where row.sqft ≤ totalSqft. Below the smallest,
  // clamp to the first row (the user's "hardening" — no gaps, no undefined tier).
  let chosen = rates[0]
  for (const r of rates) {
    if (r.sqft <= totalSqft) chosen = r
    else break
  }
  const ratePerSqft = chosen.ratePerSqft

  const baseCost  = totalSqft * ratePerSqft

  // Reuse main-config addons/turnarounds — Large Format products honour the
  // same global catalogue and the same allowed_* gating semantics.
  const addonCost = applyAddons(mainConfig, productCfg, addons, qty, baseCost)
  const tnMul     = turnaroundMultiplier(mainConfig, turnaround)

  const subtotal  = baseCost + addonCost
  const totalCost = subtotal * tnMul
  const sellPrice = totalCost * (1 + markup / 100)

  return {
    qty,
    sizeName,
    materialName,
    perPieceSqft:  round(perPieceSqft),
    totalSqft:     round(totalSqft),
    ratePerSqft:   round(ratePerSqft),
    baseCost:      round(baseCost),
    addonCost:     round(addonCost),
    turnaround,
    turnaroundMul: tnMul,
    totalCost:     round(totalCost),
    markup,
    sellPrice:     round(sellPrice),
    unitSellPrice: round(sellPrice / qty),
  }
}

// Surfaces allowed addons/turnarounds for a LF product so the UI can render
// the correct checkbox state. Same semantics as engine.js `allowed`.
function allowedFor(product, category) {
  const lf = loadLargeFormatConfig()
  const mainConfig = loadConfig()
  const productCfg = lf.products?.[product]
  if (!productCfg) return []
  return allowed(productCfg, category, mainConfig)
}

module.exports = { calculateLargeFormat, loadLargeFormatConfig, allowedFor }
