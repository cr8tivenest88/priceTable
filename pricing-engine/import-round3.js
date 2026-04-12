/**
 * Import Canvas, Posters Full, and Vinyl Adhesive from the Round 3 workbook
 * into config.json.
 *
 * Usage:  node import-round3.js
 */
const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const WB_PATH  = path.join(__dirname, '3rd and 4th Round 3 Items Canvas, Posters and Vinyl Adhesive.xlsx');
const CFG_PATH = path.join(__dirname, 'config.json');

const wb  = XLSX.readFile(WB_PATH, { cellDates: true });
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */
function sheetRows(name) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function cleanSize(s) {
  return String(s).replace(/\s+/g, '').trim();
}

/* ------------------------------------------------------------------ */
/*  1. CANVAS ROLL                                                     */
/* ------------------------------------------------------------------ */
function importCanvasRoll() {
  const rows = sheetRows('Canvas Roll');
  const headerRow = rows[1];           // row index 1 has size headers
  const dataRows  = rows.slice(2, 12); // rows 2-11 (qty 1-10)

  // Build unique sizes from header (skip col 0=label, 1=qty)
  const seen = new Set();
  const sizeCols = []; // { col, size }
  for (let c = 2; c <= 23; c++) {
    const sz = cleanSize(headerRow[c]);
    if (!sz || seen.has(sz)) continue;
    seen.add(sz);
    sizeCols.push({ col: c, size: sz });
  }

  const sizes      = sizeCols.map(s => s.size);
  const quantities = dataRows.map(r => r[1]);

  const priceTable = sizeCols.map(({ col, size }) => {
    const prices = {};
    for (const r of dataRows) {
      const qty = r[1];
      const val = r[col];
      if (qty != null && val != null) prices[String(qty)] = round4(val);
    }
    return { key: { size }, prices };
  });

  cfg.products.canvas_roll = {
    label: 'Canvas Roll',
    mode: 'lookup',
    lookup_keys: ['size'],
    options: { size: sizes },
    quantities,
    price_table: priceTable,
    allowed_addons: [],
    allowed_finishings: ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
  };

  console.log(`Canvas Roll: ${sizes.length} sizes, ${quantities.length} qty tiers, ${priceTable.length} entries`);
}

/* ------------------------------------------------------------------ */
/*  2. POSTERS – LARGE FORMAT (8pt C2S)                                */
/* ------------------------------------------------------------------ */
function importPostersLargeFormat() {
  const rows = sheetRows('Posters Full');
  const headerRow = rows[1];           // size headers
  const dataRows  = rows.slice(2, 12); // rows 2-11 (qty 1-10)

  const sizes = [];
  const sizeCols = [];
  for (let c = 2; c <= 29; c++) {
    const sz = cleanSize(headerRow[c]);
    if (!sz) continue;
    sizes.push(sz);
    sizeCols.push({ col: c, size: sz });
  }

  const quantities = dataRows.map(r => r[1]).filter(q => q != null);

  const priceTable = sizeCols.map(({ col, size }) => {
    const prices = {};
    for (const r of dataRows) {
      const qty = r[1];
      const val = r[col];
      if (qty != null && val != null) prices[String(qty)] = round4(val);
    }
    return { key: { size }, prices };
  });

  cfg.products.posters_large_format = {
    label: 'Large Format Posters (8pt C2S)',
    mode: 'lookup',
    lookup_keys: ['size'],
    options: { size: sizes },
    quantities,
    price_table: priceTable,
    allowed_addons: [],
    allowed_finishings: ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
  };

  console.log(`Posters Large Format: ${sizes.length} sizes, ${quantities.length} qty tiers, ${priceTable.length} entries`);
}

/* ------------------------------------------------------------------ */
/*  3. POSTERS – SMALL FORMAT (multiple paper stocks, base/two-side)   */
/* ------------------------------------------------------------------ */
function importPostersSmallFormat() {
  const rows = sheetRows('Posters Full');

  // Each section has:  header row with sizes, sub-header with Base/Two Side, then data rows
  // Sections start at rows: 14, 26, 42, 55
  const sections = [
    { name: '100lb Gloss Text',    key: '100lb_gloss_text',    startRow: 14, dataStart: 16, dataEnd: 24  },
    { name: 'Matte Finish 100lb',  key: 'matte_finish_100lb',  startRow: 26, dataStart: 28, dataEnd: 39  },
    { name: '80lb Enviro',         key: '80lb_enviro',          startRow: 42, dataStart: 44, dataEnd: 52  },
    { name: '100lb + UV',          key: '100lb_uv',             startRow: 55, dataStart: 57, dataEnd: 65  },
  ];

  // All sections share same 4 sizes: 12x18, 18x24, 19x27, 24x36
  // Columns: 2=base, 3=two_side, 4=base, 5=two_side, 6=base, 7=two_side, 8=base, 9=two_side
  const sizeMap = [
    { size: '12x18', baseCol: 2, twoSideCol: 3 },
    { size: '18x24', baseCol: 4, twoSideCol: 5 },
    { size: '19x27', baseCol: 6, twoSideCol: 7 },
    { size: '24x36', baseCol: 8, twoSideCol: 9 },
  ];

  const allQtys = new Set();
  const priceTable = [];

  for (const sec of sections) {
    const dataRows = rows.slice(sec.dataStart, sec.dataEnd).filter(r => r && r[1] != null);

    for (const { size, baseCol, twoSideCol } of sizeMap) {
      for (const side of ['single', 'double']) {
        const col = side === 'single' ? baseCol : twoSideCol;
        const prices = {};
        for (const r of dataRows) {
          const qty = r[1];
          const val = r[col];
          if (qty != null && val != null) {
            prices[String(qty)] = round4(val);
            allQtys.add(qty);
          }
        }
        if (Object.keys(prices).length > 0) {
          priceTable.push({
            key: { paper_stock: sec.key, size, sides: side },
            prices,
          });
        }
      }
    }
  }

  const quantities = [...allQtys].sort((a, b) => a - b);

  const paperStockOptions = sections.map(s => ({ key: s.key, label: s.name }));
  const sideOptions = [
    { key: 'single', label: 'Single Side' },
    { key: 'double', label: 'Two Sides' },
  ];

  cfg.products.posters = {
    label: 'Posters',
    mode: 'lookup',
    lookup_keys: ['paper_stock', 'size', 'sides'],
    options: {
      paper_stock: paperStockOptions,
      size: sizeMap.map(s => s.size),
      sides: sideOptions,
    },
    quantities,
    price_table: priceTable,
    allowed_addons: [],
    allowed_finishings: ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
  };

  console.log(`Posters: ${paperStockOptions.length} stocks × ${sizeMap.length} sizes × 2 sides = ${priceTable.length} entries, ${quantities.length} qty tiers`);
}

/* ------------------------------------------------------------------ */
/*  4. VINYL ADHESIVE (GLOSSY)                                         */
/* ------------------------------------------------------------------ */
function importVinylAdhesiveGlossy() {
  const rows = sheetRows('Vinyl Adhesive');
  const headerRow = rows[0];           // row 0 has size headers
  const dataRows  = rows.slice(1, 11); // rows 1-10 (qty 1-10)

  const sizes = [];
  const sizeCols = [];
  for (let c = 2; c <= 27; c++) {
    const sz = cleanSize(headerRow[c]);
    if (!sz) continue;
    sizes.push(sz);
    sizeCols.push({ col: c, size: sz });
  }

  const quantities = dataRows.map(r => r[1]).filter(q => q != null);

  const priceTable = sizeCols.map(({ col, size }) => {
    const prices = {};
    for (const r of dataRows) {
      const qty = r[1];
      const val = r[col];
      if (qty != null && val != null) prices[String(qty)] = round4(val);
    }
    return { key: { size }, prices };
  });

  cfg.products.vinyl_adhesive = {
    label: 'Vinyl Adhesive (Glossy)',
    mode: 'lookup',
    lookup_keys: ['size'],
    options: { size: sizes },
    quantities,
    price_table: priceTable,
    allowed_addons: [],
    allowed_finishings: ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
  };

  console.log(`Vinyl Adhesive Glossy: ${sizes.length} sizes, ${quantities.length} qty tiers, ${priceTable.length} entries`);
}

/* ------------------------------------------------------------------ */
/*  5. VINYL PERFORATED (WINDOW)                                       */
/* ------------------------------------------------------------------ */
function importVinylPerforated() {
  const rows = sheetRows('Vinyl Adhesive');
  const headerRow = rows[16];          // row 16 has size headers
  const dataRows  = rows.slice(17, 27); // rows 17-26 (qty 1-10)

  const sizes = [];
  const sizeCols = [];
  for (let c = 2; c <= 32; c++) {
    const sz = cleanSize(headerRow[c]);
    if (!sz) continue;
    sizes.push(sz);
    sizeCols.push({ col: c, size: sz });
  }

  const quantities = dataRows.map(r => r[1]).filter(q => q != null);

  const priceTable = sizeCols.map(({ col, size }) => {
    const prices = {};
    for (const r of dataRows) {
      const qty = r[1];
      const val = r[col];
      if (qty != null && val != null) prices[String(qty)] = round4(val);
    }
    return { key: { size }, prices };
  });

  cfg.products.vinyl_perforated = {
    label: 'Window Perforated Vinyl',
    mode: 'lookup',
    lookup_keys: ['size'],
    options: { size: sizes },
    quantities,
    price_table: priceTable,
    allowed_addons: [],
    allowed_finishings: ['no_finish'],
    allowed_turnarounds: ['regular', 'next_day', 'sameday', '1_hour'],
  };

  console.log(`Vinyl Perforated: ${sizes.length} sizes, ${quantities.length} qty tiers, ${priceTable.length} entries`);
}

/* ------------------------------------------------------------------ */
/*  RUN                                                                */
/* ------------------------------------------------------------------ */
importCanvasRoll();
importPostersLargeFormat();
importPostersSmallFormat();
importVinylAdhesiveGlossy();
importVinylPerforated();

fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
console.log('\nAll products written to config.json');
