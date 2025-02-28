const fs = require('fs').promises; // Use promises for async file operations
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';

const db = new sqlite3.Database('./mining_companies.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to database for insertion.');
});

// Define valid columns based on your schema
const validColumns = [
    'name', 'tsx_code', 'description', 'stock_price', 'stock_price_currency', 'last_updated',
    'number_of_shares', 'market_cap_value', 'market_cap_currency', 'market_cap_cad',
    'cash_value', 'cash_currency', 'cash_cad', 'debt_value', 'debt_currency', 'debt_cad',
    'enterprise_value_value', 'enterprise_value_currency', 'enterprise_value_cad',
    'revenue_value', 'revenue_currency', 'revenue_cad', 'net_income_value', 'net_income_currency', 'net_income_cad',
    'reserves_au_moz', 'resources_au_moz', 'production_total_au_eq_koz',
    'aisc_last_year_value', 'aisc_last_year_currency', 'news_link'
];

const cadFields = [
    'market_cap', 'cash', 'debt', 'enterprise_value', 'revenue', 'net_income'
];


async function generateJsonFiles() {
  const csvData = await fs.readFile(CSV_FILE, 'utf8');
  const companies = parse(csvData, { columns: true, skip_empty_lines: true });

  for (const { TICKER: ticker, NAME: name } of companies) {
    const filePath = path.join(DATA_DIR, `${ticker}.json`);
    const template = {
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
      reserves_gold_moz: 0,
      reserves_silver_moz: 0,
      resources_gold_moz: 0,
      resources_silver_moz: 0,
      potential_gold_moz: 0,
      potential_silver_moz: 0,
      reserves_precious_au_eq_koz: 0,
      resources_precious_au_eq_koz: 0,
      potential_precious_au_eq_koz: 0,
      mineable_precious_au_eq_moz: 0,
      mineable_non_precious_au_eq_moz: 0,
      mineable_all_au_eq_moz: 0,
      percentage_in_gold: 0,
      percentage_in_silver: 0,
      production_total_au_eq_koz: 0,
      aisc_last_year_value: 0,
      aisc_last_year_currency: "USD",
      news_link: `https://www.miningfeeds.com/company/${ticker.toLowerCase().replace('.to', '').replace('.v', '').replace('.cn', '')}/`,
      reserve_boost_factor: 3
    };
    try {
      await fs.stat(filePath); // Skip if exists
    } catch (e) {
      await fs.writeFile(filePath, JSON.stringify(template, null, 2));
      console.log(`Created ${ticker}.json`);
    }
  }
}

generateJsonFiles().catch(console.error);

async function getExchangeRates() {
    return new Promise((resolve) => {
        db.all('SELECT currency, rate_to_cad FROM exchange_rates', [], (err, rows) => {
            if (err) {
                console.error('Error fetching exchange rates:', err);
                resolve({ 'USD': 1.35, 'AUD': 0.90 });
            } else {
                console.log('Exchange rates fetched:', rows);
                resolve(Object.fromEntries(rows.map(row => [row.currency, row.rate_to_cad])));
            }
        });
    });
}

async function insertCompany(data) {
    const exchangeRates = await getExchangeRates();
    const fields = [];
    const values = [];
    const placeholders = [];

    for (const [key, value] of Object.entries(data)) {
        if (value !== null && value !== undefined && validColumns.includes(key)) {
            fields.push(key);
            values.push(value);
            placeholders.push('?');
            if (cadFields.some(field => key.startsWith(field + '_')) && key.endsWith('_value')) {
                const currencyKey = key.replace('_value', '_currency');
                const cadKey = key.replace('_value', '_cad');
                if (validColumns.includes(cadKey)) {
                    const currency = data[currencyKey] || 'CAD';
                    const rate = currency === 'CAD' ? 1 : (exchangeRates[currency] || 1);
                    const cadValue = value * rate;
                    fields.push(cadKey);
                    values.push(cadValue);
                    placeholders.push('?');
                }
            }
        } else if (!validColumns.includes(key)) {
            console.warn(`Skipping unknown column '${key}' for ${data.name}`);
        }
    }

    const sql = `INSERT OR REPLACE INTO companies (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`;
    return new Promise((resolve, reject) => {
        db.run(sql, values, function(err) {
            if (err) {
                console.error(`Error inserting ${data.name}: ${err.message}`);
                reject(err);
            } else {
                console.log(`Inserted/Updated ${data.name} with ID ${this.lastID}`);
                resolve();
            }
        });
    });
}

async function processDirectory(directory) {
    try {
        const files = await fs.readdir(directory);
        console.log(`Processing files in ${directory}:`, files);
        const insertionPromises = files
            .filter(file => path.extname(file) === '.json')
            .map(async (file) => {
                const filePath = path.join(directory, file);
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    const data = JSON.parse(content);
                    await insertCompany(data);
                } catch (err) {
                    console.error(`Failed to process ${file}: ${err.message}`);
                }
            });

        await Promise.all(insertionPromises);
        console.log('All files processed.');
    } catch (err) {
        console.error('Error reading directory:', err);
    } finally {
        db.close((err) => {
            if (err) console.error('Error closing database:', err);
            else console.log('Database connection closed.');
        });
    }
}

(async () => {
    if (process.argv.length < 3) {
        console.log('Usage: node insert_companies.js <directory>');
        process.exit(1);
    }

    await processDirectory(process.argv[2]);
})();
