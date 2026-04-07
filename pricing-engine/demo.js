/**
 * Demo — run with: node demo.js
 */

const { calculatePrice, buildPriceTable } = require('./engine')

// ─── Single price lookup ───────────────────────────────────────────────────

console.log('\n── Single Price Lookup ──────────────────────────────────────')
const single = calculatePrice({
  product:   'business-cards',
  material:  '14pt-matte-cardstock',
  finishing: 'glossy',
  qty:       500,
  markup:    40,   // 40% markup on top of cost
})
console.log(single)
/*
  {
    qty: 500,
    finishing: 'glossy',
    baseCost: 14.23,      ← raw print cost
    finishCost: 8.50,     ← glossy lamination cost
    totalCost: 22.73,     ← what it costs YOU
    markup: '40%',
    sellPrice: 31.82,     ← what you charge the customer
    unitSellPrice: 0.06   ← per card sell price
  }
*/

// ─── Full price table ──────────────────────────────────────────────────────

console.log('\n── Full Price Table (14pt Matte, 40% markup) ────────────────')
const table = buildPriceTable({
  product:  'business-cards',
  material: '14pt-matte-cardstock',
  markup:   40,
})

// Pretty print as a table
const finishings = Object.keys(table[0].finishings)

// Header
const header = ['QTY', ...finishings.map(f => f.toUpperCase())]
console.log('\nSELL PRICE TABLE')
console.log(header.map(h => h.padEnd(16)).join(''))
console.log('─'.repeat(header.length * 16))

// Rows
for (const row of table) {
  const cols = [
    String(row.qty).padEnd(16),
    ...finishings.map(f => `$${row.finishings[f].sellPrice}`.padEnd(16))
  ]
  console.log(cols.join(''))
}

// Unit price table
console.log('\nUNIT SELL PRICE TABLE (per card)')
console.log(header.map(h => h.padEnd(16)).join(''))
console.log('─'.repeat(header.length * 16))

for (const row of table) {
  const cols = [
    String(row.qty).padEnd(16),
    ...finishings.map(f => `$${row.finishings[f].unitSellPrice}`.padEnd(16))
  ]
  console.log(cols.join(''))
}

// Cost vs sell comparison for one finishing
console.log('\n── Cost vs Sell — Glossy, 40% markup ───────────────────────')
console.log('QTY'.padEnd(8) + 'BASE COST'.padEnd(14) + 'FINISH COST'.padEnd(14) + 'TOTAL COST'.padEnd(14) + 'SELL PRICE'.padEnd(14) + 'UNIT SELL')
console.log('─'.repeat(78))
for (const row of table) {
  const g = row.finishings['glossy']
  console.log(
    String(g.qty).padEnd(8) +
    `$${g.baseCost}`.padEnd(14) +
    `$${g.finishCost}`.padEnd(14) +
    `$${g.totalCost}`.padEnd(14) +
    `$${g.sellPrice}`.padEnd(14) +
    `$${g.unitSellPrice}`
  )
}
