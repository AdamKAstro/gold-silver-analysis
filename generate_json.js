const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';

async function generateJsonFiles() {
  const csvData = await fs.readFile(CSV_FILE, 'utf8');
  const companies = parse(csvData, { columns: true, skip_empty_lines: true });

  for (const { TICKER: ticker, NAME: name } of companies) {
    const filePath = path.join(DATA_DIR, `${ticker}.json`);
    const jsonData = {
      name,
      tsx_code: ticker,
      stock_price: 0,
      market_cap_value: 0,
      market_cap_currency: "CAD",
      last_updated: new Date().toISOString(),
      reserves_gold_moz: 0,
      reserves_silver_moz: 0,
      resources_gold_moz: 0,
      resources_silver_moz: 0,
      mineable_all_au_eq_moz: 0,
      percentage_in_gold: 0,
      percentage_in_silver: 0
    };
    try {
      await fs.stat(filePath);
    } catch (e) {
      await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
      console.log(`Created ${ticker}.json`);
    }
  }
}

generateJsonFiles().catch(console.error);
