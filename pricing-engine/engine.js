/**
 * Pricing Engine
 *
 * Cost flow:
 *   base_cost      = setup + per_unit_cost × qty^scale_factor   (Base type)
 *   modifier_cost  = sum of cost_modifier × qty                 (Modifier type — flat $/unit)
 *   surcharge_cost = sum of base_cost × (surcharge_pct / 100)   (Surcharge type — % of base)
 *   finish_cost    = flat + per_unit × qty
 *   total_cost     = base_cost + modifier_cost + surcharge_cost + finish_cost
 *   sell_price     = total_cost × (1 + markup / 100)
 */

const fs   = require('fs')
const path = require('path')

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')
  return JSON.parse(raw)
}

/**
 * Calculate price for one combination.
 *
 * @param {object} opts
 * @param {string} opts.product      - product key e.g. "business-cards"
 * @param {object} opts.specs        - selected spec options e.g. { material: "14pt-matte", printing: "front_only" }
 *                                     The FIRST spec that has setup_cost/per_unit_cost is used as the base.
 * @param {string} opts.finishing    - finishing key e.g. "glossy_lam"
 * @param {number} opts.qty
 * @param {number} opts.markup       - percentage e.g. 40
 */
function calculatePrice({ product, specs = {}, finishing, qty, markup = 0 }) {
  const config = loadConfig()

  const productCfg = config.products[product]
  if (!productCfg) throw new Error(`Unknown product: ${product}`)

  const finCfg = config.finishings[finishing]
  if (!finCfg) throw new Error(`Unknown finishing: ${finishing}`)

  if (!productCfg.allowed_finishings.includes(finishing)) {
    throw new Error(`Finishing "${finishing}" not allowed for product "${product}"`)
  }

  // Find the primary spec (the one with setup_cost — drives the power curve)
  let baseCost     = 0
  let addonCost    = 0
  let surchargeCost = 0
  let primaryFound = false

  // First pass — find base cost
  for (const [specKey, specValue] of Object.entries(specs)) {
    const specDef = productCfg.specs[specKey]
    if (!specDef) continue
    const optDef = specDef.options[specValue]
    if (!optDef) continue

    if (!primaryFound && optDef.setup_cost !== undefined) {
      baseCost     = optDef.setup_cost + optDef.per_unit_cost * Math.pow(qty, optDef.scale_factor)
      primaryFound = true
    } else if (optDef.cost_modifier !== undefined) {
      addonCost += optDef.cost_modifier * qty
    }
  }

  // Second pass — apply surcharges (need baseCost to be known first)
  for (const [specKey, specValue] of Object.entries(specs)) {
    const specDef = productCfg.specs[specKey]
    if (!specDef) continue
    const optDef = specDef.options[specValue]
    if (!optDef) continue

    if (optDef.surcharge_pct !== undefined) {
      surchargeCost += baseCost * (optDef.surcharge_pct / 100)
    }
  }

  const finishCost = finCfg.flat + finCfg.per_unit * qty
  const totalCost  = baseCost + addonCost + surchargeCost + finishCost
  const sellPrice  = totalCost * (1 + markup / 100)

  return {
    qty,
    finishing,
    baseCost:      round(baseCost),
    addonCost:     round(addonCost),
    surchargeCost: round(surchargeCost),
    finishCost:    round(finishCost),
    totalCost:     round(totalCost),
    markup:        markup,
    sellPrice:     round(sellPrice),
    unitSellPrice: round(sellPrice / qty),
  }
}

/**
 * Build a full price table across all quantities and all allowed finishings.
 *
 * @param {object} opts
 * @param {string} opts.product
 * @param {object} opts.specs     - selected spec options (same as calculatePrice)
 * @param {number} opts.markup
 */
function buildPriceTable({ product, specs = {}, markup = 0 }) {
  const config = loadConfig()
  const productCfg = config.products[product]
  if (!productCfg) throw new Error(`Unknown product: ${product}`)

  return productCfg.quantities.map(qty => {
    const row = { qty, finishings: {} }
    for (const finishing of productCfg.allowed_finishings) {
      row.finishings[finishing] = calculatePrice({ product, specs, finishing, qty, markup })
    }
    return row
  })
}

function round(n) {
  return Math.round(n * 100) / 100
}

/**
 * Generate ALL combinations of specs × finishings × quantities for a product.
 * Returns a flat array of rows, each fully labelled for display.
 *
 * @param {object} opts
 * @param {string} opts.product
 * @param {number} opts.markup
 */
function generateAllCombos({ product, markup = 0 }) {
  const config     = loadConfig()
  const productCfg = config.products[product]
  if (!productCfg) throw new Error(`Unknown product: ${product}`)

  // Build array of [specKey, optionKey] pairs per spec group
  const specGroups = Object.entries(productCfg.specs).map(([specKey, specDef]) => ({
    specKey,
    label: specDef.label,
    options: Object.entries(specDef.options).map(([optKey, optDef]) => ({
      key: optKey,
      label: optDef.label,
    }))
  }))

  // Cartesian product of all spec options
  const specCombos = cartesian(specGroups.map(g => g.options.map(o => ({ [g.specKey]: o.key }))))

  const rows = []

  for (const specCombo of specCombos) {
    // Merge { material: '14pt-matte' }, { printing: 'front_only' }, ... into one object
    const specs = Object.assign({}, ...specCombo)

    // Build a human-readable label for this combo
    const comboLabel = specGroups.map(g => {
      const opt = g.options.find(o => o.key === specs[g.specKey])
      return `${g.label}: ${opt ? opt.label : specs[g.specKey]}`
    }).join(' · ')

    for (const finishing of productCfg.allowed_finishings) {
      const finLabel = config.finishings[finishing]?.label ?? finishing

      for (const qty of productCfg.quantities) {
        const price = calculatePrice({ product, specs, finishing, qty, markup })
        rows.push({
          comboLabel,
          specs,
          finishing,
          finishingLabel: finLabel,
          ...price,
        })
      }
    }
  }

  return rows
}

/**
 * Cartesian product of arrays.
 * cartesian([[a,b],[c,d]]) → [[a,c],[a,d],[b,c],[b,d]]
 */
function cartesian(arrays) {
  return arrays.reduce((acc, arr) => {
    const result = []
    for (const a of acc) {
      for (const b of arr) result.push([...a, b])
    }
    return result
  }, [[]])
}

module.exports = { calculatePrice, buildPriceTable, generateAllCombos, loadConfig }
