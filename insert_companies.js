const fs = require('fs').promises; // Use promises for async file operations
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

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