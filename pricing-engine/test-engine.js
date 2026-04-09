const e = require('./engine')
const cfg = e.loadConfig()
let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { console.log('  PASS', name); pass++ }
  else      { console.log('  FAIL', name, detail || ''); fail++ }
}

console.log('\n=== 1. Config sanity ===')
check('6 products loaded',         Object.keys(cfg.products).length === 6)
check('globals.finishings present', !!cfg.globals.finishings.glossy_lam)
check('globals.turnaround present', !!cfg.globals.turnaround.next_day)
check('globals.addons present',     !!cfg.globals.addons.grommet)

console.log('\n=== 2. Brochure (lookup) ===')
const broSpecs = { size: '8.5" x 11"', paper_stock: '100lb Gloss Text / 80lb Gloss Text', folding: 'Half Fold / Tri-Fold / Z-Fold' }
const b25 = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 25,   markup: 0 })
const b75 = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 75,   markup: 0 })
const b10 = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 10,   markup: 0 })
const b9k = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 9999, markup: 0 })
check('exact qty 25 unit=1.35',                          b25.unitBase === 1.35)
check('exact qty 25 base=33.75',                         b25.baseCost === 33.75)
check('interp qty 75 unit between 1.18 and 1.21',        b75.unitBase > 1.18 && b75.unitBase < 1.21)
check('clamp low qty 10 → 1.35',                         b10.unitBase === 1.35)
check('clamp high qty 9999 → 0.45',                      b9k.unitBase === 0.45)

console.log('\n=== 3. Add-ons ===')
const bAdd = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0,
  addons: [{ key: 'grommet', count: 4 }, { key: 'h_stand', count: 2 }] })
check('grommet*4 + h_stand*2 = 5.62', Math.abs(bAdd.addonCost - (0.75*4 + 1.31*2)) < 0.01)

const bDS = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0, addons: ['double_sided'] })
check('double_sided pct of base', Math.abs(bDS.addonCost - 118 * 0.4 / 100) < 0.01)

console.log('\n=== 4. Turnaround multipliers ===')
const tReg = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0, turnaround: 'regular' })
const tNxt = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0, turnaround: 'next_day' })
const tSam = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0, turnaround: 'sameday' })
const tHr  = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0, turnaround: '1_hour' })
check('next_day = base × 1.2', Math.abs(tNxt.totalCost - tReg.totalCost * 1.2) < 0.01)
check('sameday  = base × 1.3', Math.abs(tSam.totalCost - tReg.totalCost * 1.3) < 0.01)
check('1_hour   = base × 1.5', Math.abs(tHr.totalCost  - tReg.totalCost * 1.5) < 0.01)

console.log('\n=== 5. Finishing ===')
const fGl = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0, finishing: 'glossy_lam' })
const fSt = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0, finishing: 'soft_touch' })
check('glossy_lam: 2.5 + 0.012*100 = 3.7', Math.abs(fGl.finishCost - 3.7) < 0.01)
check('soft_touch: 4 + 0.018*100 = 5.8',   Math.abs(fSt.finishCost - 5.8) < 0.01)

console.log('\n=== 6. Markup ===')
const m0  = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0  })
const m50 = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 50 })
check('markup 50 = total × 1.5', Math.abs(m50.sellPrice - m0.totalCost * 1.5) < 0.01)

console.log('\n=== 7. Flyer (lookup, sides as key) ===')
const fly1 = e.calculatePrice({ product: 'flyer', specs: { size: '4" x 6"', paper_stock: '80lb Gloss Text / 100lb Gloss Text', sides: 'single' }, qty: 100, markup: 0 })
const fly2 = e.calculatePrice({ product: 'flyer', specs: { size: '4" x 6"', paper_stock: '80lb Gloss Text / 100lb Gloss Text', sides: 'double' }, qty: 100, markup: 0 })
check('flyer single < double', fly1.unitBase < fly2.unitBase)

console.log('\n=== 8. Business Card (4 variants) ===')
const bc1 = e.calculatePrice({ product: 'business_card', specs: { size: '3.5x2', paper_stock: 'Semi Gloss', variant: 'base'            }, qty: 500, markup: 0 })
const bc2 = e.calculatePrice({ product: 'business_card', specs: { size: '3.5x2', paper_stock: 'Semi Gloss', variant: 'ds_round_corner' }, qty: 500, markup: 0 })
check('bc base < bc ds_round_corner', bc1.unitBase < bc2.unitBase)

console.log('\n=== 9. Booklets (lookup mode + line-total flag) ===')
const bk1 = e.calculatePrice({ product: 'booklets', specs: { size: '5.5x8.5', paper_stock: 'Gloss 216 gsm', pages: 16, cover: 'base' }, qty: 5,  markup: 0 })
const bk2 = e.calculatePrice({ product: 'booklets', specs: { size: '5.5x8.5', paper_stock: 'Gloss 216 gsm', pages: 16, cover: 'base' }, qty: 7,  markup: 0 })
const bk3 = e.calculatePrice({ product: 'booklets', specs: { size: '5.5x8.5', paper_stock: 'Gloss 216 gsm', pages: 16, cover: 'base' }, qty: 10, markup: 0 })
check('booklet qty 5 published',          bk1.unitBase === 79)
check('booklet qty 7 between 5 & 10',     bk2.unitBase > bk1.unitBase && bk2.unitBase < bk3.unitBase)
check('booklet base == unitBase (line)',  bk2.baseCost === bk2.unitBase)

console.log('\n=== 10. NCR Forms (setup + slope) ===')
const ncrBase = e.calculatePrice({ product: 'ncr_forms', specs: { size: '5.5x8.5', variant: '2part_single_color' }, qty: 25, markup: 0 })
// Expected: setup $80 + 0.69 × 25 = $97.25
check('NCR 25 books 2pt single = $97.25', Math.abs(ncrBase.baseCost - 97.25) < 0.01)
check('NCR setup field present',          ncrBase.setup === 80)
check('NCR marginal field present',       ncrBase.marginal === 0.69)

const ncr3pt = e.calculatePrice({ product: 'ncr_forms', specs: { size: '5.5x8.5', variant: '3part_single_color' }, qty: 25, markup: 0 })
check('NCR 25 books 3pt single = $142.25', Math.abs(ncr3pt.baseCost - 142.25) < 0.01)

const ncrAddons = e.calculatePrice({ product: 'ncr_forms', specs: { size: '5.5x8.5', variant: '2part_single_color' }, qty: 25, markup: 0,
  addons: [{ key: 'ncr_book_wrap' }, { key: 'ncr_numbering' }] })
// 25 books × ($10 wrap + $20 numbering) = $750 add-ons
check('NCR addons per-book × qty = $750', ncrAddons.addonCost === 750)
check('NCR total = $97.25 base + $750 addons', Math.abs(ncrAddons.totalCost - 847.25) < 0.01)

console.log('\n=== 11. Coroplast (lookup mode) ===')
const co1  = e.calculatePrice({ product: 'coroplast', specs: { thickness: '4mm', size: '6x24', variant: '1_side' }, qty: 1,  markup: 0 })
const co8  = e.calculatePrice({ product: 'coroplast', specs: { thickness: '4mm', size: '6x24', variant: '1_side' }, qty: 8,  markup: 0 })
const co50 = e.calculatePrice({ product: 'coroplast', specs: { thickness: '4mm', size: '6x24', variant: '1_side' }, qty: 50, markup: 0 })
const coGr8 = e.calculatePrice({ product: 'coroplast', specs: { thickness: '4mm', size: '6x24', variant: 'grommet_all_4' }, qty: 8, markup: 0 })
check('coroplast 4mm 6x24 1side qty 1 = $7.94',  co1.unitBase === 7.94)
check('coroplast 4mm 6x24 1side qty 8 = $2.61',  co8.unitBase === 2.61)
check('coroplast 4mm 6x24 1side qty 50 = $2.03', co50.unitBase === 2.03)
check('coroplast grommet_all_4 > 1side at same qty', coGr8.unitBase > co8.unitBase)
check('config has sheet_imposition', !!cfg.products.coroplast.sheet_imposition?.pieces_per_sheet?.['12x24'])

console.log('\n=== 12. Default-allowed (no allowed_finishings) ===')
// brochure no longer declares allowed_finishings — engine should fall back to ALL globals
const defFin = e.calculatePrice({ product: 'brochure', specs: broSpecs, qty: 100, markup: 0, finishing: 'foil_gold' })
check('foil_gold (not in old allowed list) now works by default', defFin.finishCost > 0)

console.log('\n=== 12b. Unified Sides resolver ===')
// Flyer: sides should resolve into specs.sides
const flySingle = e.calculatePrice({ product: 'flyer', specs: { size: '4" x 6"', paper_stock: '80lb Gloss Text / 100lb Gloss Text' }, sides: 1, qty: 100, markup: 0 })
const flyDouble = e.calculatePrice({ product: 'flyer', specs: { size: '4" x 6"', paper_stock: '80lb Gloss Text / 100lb Gloss Text' }, sides: 2, qty: 100, markup: 0 })
check('flyer sides=1 resolves to single', flySingle.unitBase < flyDouble.unitBase)

// Business card: sides=2 should swap base→double_sided
const bcSingle = e.calculatePrice({ product: 'business_card', specs: { size: '3.5x2', paper_stock: 'Semi Gloss', variant: 'base' }, sides: 1, qty: 500, markup: 0 })
const bcDouble = e.calculatePrice({ product: 'business_card', specs: { size: '3.5x2', paper_stock: 'Semi Gloss', variant: 'base' }, sides: 2, qty: 500, markup: 0 })
check('business_card sides=2 swaps to double_sided', bcSingle.unitBase < bcDouble.unitBase)

// Brochure: sides=2 should auto-apply double_sided add-on
const broSingle = e.calculatePrice({ product: 'brochure', specs: broSpecs, sides: 1, qty: 100, markup: 0 })
const broDouble = e.calculatePrice({ product: 'brochure', specs: broSpecs, sides: 2, qty: 100, markup: 0 })
check('brochure sides=2 auto-adds double_sided add-on', broDouble.addonCost > broSingle.addonCost)

console.log('\n=== 13. buildPriceTable + generateAllCombos ===')
const tbl = e.buildPriceTable({ product: 'brochure', specs: broSpecs, markup: 40 })
const all = e.generateAllCombos({ product: 'brochure', markup: 40 })
check('buildPriceTable rows = qtys',   tbl.length === cfg.products.brochure.quantities.length)
check('each row has finishings',       !!tbl[0].finishings.no_finish)
check('generateAllCombos > 0 rows',    all.length > 0)

console.log('\n========================================')
console.log('  ' + pass + ' passed · ' + fail + ' failed')
console.log('========================================')
process.exit(fail === 0 ? 0 : 1)
