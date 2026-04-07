# Pricing Engine — Comprehensive Guide

## Overview

This pricing engine calculates print product costs and sell prices based on a configurable product catalog. It supports multiple products (Business Cards, Flyers, Stickers, etc.), each with their own spec groups, options, and allowed finishings. A markup percentage is applied on top of the total cost to produce the final sell price.

---

## How to Run

```bash
cd pricing-engine
npm install
npm start
```

Open `http://localhost:3000` in your browser to access the admin UI.

---

## The Cost Formula

Every price is calculated in four layers:

```
base_cost      = setup_cost + per_unit_cost × qty ^ scale_factor
addon_cost     = Σ (cost_modifier × qty)          for each Modifier option selected
surcharge_cost = Σ (base_cost × surcharge_pct%)   for each Surcharge option selected
finish_cost    = flat + per_unit × qty

total_cost     = base_cost + addon_cost + surcharge_cost + finish_cost
sell_price     = total_cost × (1 + markup / 100)
unit_sell      = sell_price / qty
```

### Worked Example

500 Business Cards — 14pt Matte, Front & Back, Rounded Corners, Rush 3 Days, Glossy Lamination, 40% markup:

| Layer          | Calculation                          | Amount  |
|----------------|--------------------------------------|---------|
| base_cost      | 8.00 + 0.028 × 500^0.65              | $9.59   |
| addon_cost     | (0.008 + 0.005) × 500                | $6.50   |
| surcharge_cost | 9.59 × 10%                           | $0.96   |
| finish_cost    | 2.50 + 0.012 × 500                   | $8.50   |
| **total_cost** |                                      | **$25.55** |
| **sell_price** | 25.55 × 1.40                         | **$35.77** |
| unit_sell      | 35.77 / 500                          | $0.07   |

---

## Config Structure (`config.json`)

The entire pricing model lives in `config.json`. No code changes are needed to add products, specs, or finishings.

### Top-level shape

```json
{
  "finishings": { ... },
  "products": { ... }
}
```

---

## Finishings

Finishings are global and can be assigned to any product. Each finishing has a flat setup cost and a per-unit cost.

```json
"finishings": {
  "glossy_lam": {
    "label": "Glossy Lamination",
    "flat": 2.50,
    "per_unit": 0.012
  }
}
```

| Field      | Description                                      |
|------------|--------------------------------------------------|
| `label`    | Display name shown in the UI and price table     |
| `flat`     | Fixed cost per job regardless of quantity        |
| `per_unit` | Additional cost per unit (card, flyer, sticker)  |

**Cost formula:** `finish_cost = flat + per_unit × qty`

**Example:** Glossy Lam on 500 cards = `2.50 + 0.012 × 500 = $8.50`

---

## Products

Each product has:
- A list of quantity tiers
- Spec groups (the options a customer picks)
- A list of allowed finishings

```json
"products": {
  "business-cards": {
    "label": "Business Cards",
    "quantities": [25, 50, 100, 250, 500, 1000],
    "specs": { ... },
    "allowed_finishings": ["no_finish", "glossy_lam", "matte_lam"]
  }
}
```

---

## Spec Groups

Spec groups represent the choices available for a product — Material, Printing, Size, Corners, Turnaround, etc.

Each group has a key, a display label, and a set of options. Each option is one of three types:

---

### Type 1 — Base (power curve)

The primary material/stock. Drives the core print cost using a power curve that creates natural bulk discounts.

```json
"14pt-matte": {
  "label": "14pt Cardstock Matte",
  "setup_cost": 8.00,
  "per_unit_cost": 0.028,
  "scale_factor": 0.65
}
```

| Field           | Description                                                  |
|-----------------|--------------------------------------------------------------|
| `setup_cost`    | Fixed plate/press setup fee paid regardless of quantity      |
| `per_unit_cost` | Raw cost per unit before scale kicks in                      |
| `scale_factor`  | Controls how aggressively bulk discounts apply (see below)   |

**Formula:** `base_cost = setup_cost + per_unit_cost × qty ^ scale_factor`

Only one option per product should be a Base — typically the Material group. The base cost already assumes the default print configuration (e.g. front-only printing).

#### Scale Factor Reference

| Scale Factor | Behaviour                              | Good for                        |
|--------------|----------------------------------------|---------------------------------|
| 0.50         | Steep discount — cost barely grows    | Digital / low marginal cost     |
| 0.65         | Moderate discount — typical print     | Business cards, flyers          |
| 0.80         | Mild discount — near-linear growth    | Premium / labour-heavy items    |
| 1.00         | No discount — fully linear            | Custom / one-off work           |

**Example with setup=$8, per_unit=$0.028, scale=0.65:**

| Qty  | Print Cost | Unit Cost |
|------|-----------|-----------|
| 25   | $8.23     | $0.33     |
| 100  | $8.56     | $0.09     |
| 500  | $9.59     | $0.02     |
| 1000 | $10.50    | $0.01     |

---

### Type 2 — Modifier (flat per-unit add-on)

A fixed cost added per unit. Use for anything that adds a physical cost per piece.

```json
"rounded": {
  "label": "Rounded Corners",
  "cost_modifier": 0.005
}
```

**Formula:** `addon_cost = cost_modifier × qty`

**Example:** Rounded corners on 1000 cards = `0.005 × 1000 = $5.00`

A `cost_modifier` of `0` is valid — it means no extra cost but keeps the option explicit in the price table (e.g. "Front Only = $0", "Straight Corners = $0").

**When to use Modifier:**
- Rounded corners (die-punch cost per card)
- Double-sided printing (extra ink + press pass per unit)
- Larger size (more material per unit)
- Die cut shape (extra cutting per unit)
- Black & white vs colour (ink cost difference per unit)

---

### Type 3 — Surcharge (percentage of base cost)

A percentage applied to the base cost. Use for job-level premiums that scale with the job value, not the unit count.

```json
"rush_3day": {
  "label": "Rush (3 days)",
  "surcharge_pct": 10
}
```

**Formula:** `surcharge_cost = base_cost × (surcharge_pct / 100)`

**Example:** 10% rush surcharge on a job with base_cost=$9.59 → `9.59 × 0.10 = $0.96`

Note: surcharge is calculated on `base_cost` only, not on the full total. This means it doesn't compound with finishings or other add-ons.

**When to use Surcharge:**
- Rush / expedited turnaround (e.g. 3-day = 10%, 1-day = 25%)
- Special handling fees
- Premium service tiers

---

## Modifier vs Surcharge — When to Use Which

| Scenario                        | Use        | Why                                              |
|---------------------------------|------------|--------------------------------------------------|
| Rounded corners                 | Modifier   | Physical work per card — scales with unit count  |
| Double-sided printing           | Modifier   | Extra ink per card — scales with unit count      |
| Larger paper size               | Modifier   | More material per unit                           |
| Rush turnaround                 | Surcharge  | Premium on the whole job, not per unit           |
| Special handling fee            | Surcharge  | Job-level cost, not tied to unit count           |
| Premium service tier            | Surcharge  | Percentage uplift on base production cost        |

---

## Adding a New Product

1. Open the admin UI → **Products** tab
2. Click **+ New**
3. Fill in:
   - **Product Key** — unique identifier, no spaces (e.g. `postcards`)
   - **Display Name** — shown in UI (e.g. `Postcards`)
   - **Quantities** — comma separated (e.g. `25, 50, 100, 250, 500`)
4. Go to **Spec Groups** tab → add groups:
   - First group = Material with Base options (setup_cost, per_unit_cost, scale_factor)
   - Other groups = Modifier or Surcharge options
5. Go to **Finishings** tab → check which finishings apply
6. Click **Save**

---

## Adding a New Finishing

1. Open the admin UI → **Finishings** tab
2. Click **+ New Finishing**
3. Fill in key, label, flat cost, per-unit cost
4. Click **Save**
5. Go to each product that should offer this finishing → **Finishings** tab → check it

---

## Adding a Turnaround Surcharge (Example)

In the Products editor, add a new spec group:

| Field        | Value         |
|--------------|---------------|
| Group Key    | `turnaround`  |
| Display Label| `Turnaround`  |

Options:

| Key          | Label           | Type      | Value          |
|--------------|-----------------|-----------|----------------|
| `standard`   | Standard 7 days | Modifier  | $0.00 / unit   |
| `rush_3day`  | Rush 3 days     | Surcharge | 10%            |
| `rush_1day`  | Rush 1 day      | Surcharge | 25%            |

---

## Generating a Price Table

### Custom Combo
Pick one option per spec group and generate a table showing all finishings × all quantity tiers.

### All Combos
Generates every possible combination of spec options × finishings × quantities in one flat table. Use the filter dropdowns to slice to the rows you need.

**Row count formula:**
```
total rows = (options in spec group 1) × (options in spec group 2) × ... × finishings × qty tiers
```

Example — Business Cards with 3 materials × 2 printing × 3 corners × 2 turnaround × 7 finishings × 6 qty tiers = **1,512 rows**

---

## API Reference

The server exposes these endpoints:

| Method | Endpoint          | Description                              |
|--------|-------------------|------------------------------------------|
| GET    | `/api/config`     | Returns full config.json                 |
| PUT    | `/api/config`     | Saves updated config.json                |
| POST   | `/api/price`      | Calculate a single price                 |
| POST   | `/api/price-table`| Full table for one spec combo            |
| POST   | `/api/all-combos` | All combinations for a product           |

### POST `/api/price`

```json
{
  "product": "business-cards",
  "specs": {
    "material": "14pt-matte",
    "printing": "front_and_back",
    "corners": "rounded",
    "turnaround": "rush_3day"
  },
  "finishing": "glossy_lam",
  "qty": 500,
  "markup": 40
}
```

**Response:**
```json
{
  "qty": 500,
  "finishing": "glossy_lam",
  "baseCost": 9.59,
  "addonCost": 6.50,
  "surchargeCost": 0.96,
  "finishCost": 8.50,
  "totalCost": 25.55,
  "markup": 40,
  "sellPrice": 35.77,
  "unitSellPrice": 0.07
}
```

### POST `/api/price-table`

```json
{
  "product": "business-cards",
  "specs": { "material": "14pt-matte", "printing": "front_only", "corners": "straight" },
  "markup": 40
}
```

Returns an array of rows, one per quantity tier, each with all allowed finishings priced.

### POST `/api/all-combos`

```json
{
  "product": "business-cards",
  "markup": 40
}
```

Returns a flat array of every spec × finishing × qty combination, fully labelled.

---

## File Structure

```
pricing-engine/
├── config.json       — all products, specs, finishings (edit this to configure pricing)
├── engine.js         — core calculation logic
├── server.js         — Express API server
├── package.json
└── client/
    ├── index.html    — admin UI
    ├── app.js        — frontend logic
    └── style.css     — styles
```

---

## Tips

- **Tune `scale_factor` first.** It has the biggest impact on how your bulk discounts look. Use the `?` button in the spec editor to preview the curve live.
- **Keep `cost_modifier = 0` for default options.** It makes the all-combos table complete and filterable without affecting the price.
- **Surcharges don't stack on finishings.** They only apply to `base_cost`, so a 10% rush fee on a $9.59 base is always $0.96 regardless of which finishing is chosen.
- **The base cost already includes front-only printing.** If you want to model printing as a separate cost, lower `per_unit_cost` on the material and add a Modifier for front-only at your base print rate.
