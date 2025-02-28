const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';

async function generateJsonFiles() {
  try {
    const csvData = await fs.readFile(CSV_FILE, 'utf8');
    const cleanedCsvData = csvData.replace(/^\ufeff/, '');
    console.log('CSV Header:', cleanedCsvData.split('\n')[0]);
    const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });
    console.log('Parsed Companies Count:', companies.length);

    for (const company of companies) {
      const ticker = company.TICKER || company['﻿TICKER'];
      const name = company.NAME || 'Unknown Name';
      console.log(`Processing: ${ticker}, ${name}`);

      if (!ticker) {
        console.error('Skipping: No valid TICKER found for row:', company);
        continue;
      }

      const filePath = path.join(DATA_DIR, `${ticker}.json`);
      const jsonData = {
        name,
        tsx_code: ticker,
        description: "A Canadian mining company involved in gold or silver.",
        stock_price: 0,
        stock_price_currency: "CAD",
        last_updated: new Date().toISOString(),
        number_of_shares: 0,
        market_cap_value: 0,
        market_cap_currency: "CAD",
        cash_value: 0,
        cash_currency: "USD",
        debt_value: 0,
        debt_currency: "USD",
        enterprise_value_value: 0,
        enterprise_value_currency: "CAD",
        revenue_value: 0,
        revenue_currency: "USD",
        net_income_value: 0,
        net_income_currency: "USD",
        reserves_au_moz: 0,
        resources_au_moz: 0,
        production_total_au_eq_koz: 0,
        aisc_last_year_value: 0,
        aisc_last_year_currency: "USD",
        news_link: `https://www.miningfeeds.com/company/${ticker.toLowerCase().replace('.to', '').replace('.v', '').replace('.cn', '')}/`
      };

      try {
        await fs.stat(filePath);
        console.log(`${ticker}.json already exists, skipping`);
      } catch (e) {
        await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
        console.log(`Created ${ticker}.json`);
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

generateJsonFiles();