const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cheerio = require('cheerio');

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';

const db = new sqlite3.Database('./mining_companies.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to database for insertion.');
});

const validColumns = [
    'name', 'tsx_code', 'description', 'stock_price', 'stock_price_currency', 'last_updated',
    'number_of_shares', 'market_cap_value', 'market_cap_currency', 'market_cap_cad',
    'cash_value', 'cash_currency', 'cash_cad', 'debt_value', 'debt_currency', 'debt_cad',
    'enterprise_value_value', 'enterprise_value_currency', 'enterprise_value_cad',
    'revenue_value', 'revenue_currency', 'revenue_cad', 'net_income_value', 'net_income_currency', 'net_income_cad',
    'reserves_gold_moz', 'reserves_silver_moz', 'resources_gold_moz', 'resources_silver_moz',
    'resources_copper_mlb', 'resources_zinc_mlb', 'resources_manganese_mt',
    'potential_gold_moz', 'potential_silver_moz',
    'reserves_precious_au_eq_koz', 'resources_precious_au_eq_koz', 'potential_precious_au_eq_koz',
    'mineable_precious_au_eq_moz', 'mineable_non_precious_au_eq_moz', 'mineable_all_au_eq_moz',
    'percentage_in_gold', 'percentage_in_silver', 'production_total_au_eq_koz',
    'aisc_last_year_value', 'aisc_last_year_currency', 'news_link', 'reserve_boost_factor',
    'resources_detailed', 'mining_summary',
    'company_website', 'resources_gold_moz_from_overview', 'resources_silver_moz_from_overview', 'last_updated_overview'
];

const cadFields = [
    'market_cap', 'cash', 'debt', 'enterprise_value', 'revenue', 'net_income'
];

// Hardcoded company websites
const COMPANY_WEBSITES = {
    'TLG.TO': 'https://troilusgold.com',
    'AAG.V': 'https://aftermathsilver.com',
    'VIPR.V': 'https://www.silverviperminerals.com'
};

async function fetchOverviewData(ticker) {
    const website = COMPANY_WEBSITES[ticker];
    if (!website) return null;

    const overviewUrls = [
        `${website}/investors/overview/`,
        `${website}/company/overview/`,
        `${website}/about-us/`
    ];

    for (const url of overviewUrls) {
        try {
            const response = await axios.get(url, { timeout: 5000 });
            const $ = cheerio.load(response.data);
            const text = $('body').text().replace(/\s+/g, ' ').trim();

            const goldMozMatch = text.match(/indicated mineral resources.*?(\d+\.?\d*)\s*Moz\s*AuEq/i);
            const silverMozMatch = text.match(/silver.*?(\d+\.?\d*)\s*Moz/i);

            if (goldMozMatch) {
                return {
                    resources_gold_moz_from_overview: parseFloat(goldMozMatch[1]),
                    resources_silver_moz_from_overview: silverMozMatch ? parseFloat(silverMozMatch[1]) : 0,
                    last_updated_overview: new Date().toISOString()
                };
            }
        } catch (err) {
            console.warn(`Failed to fetch overview data from ${url}: ${err.message}`);
        }
    }
    return null;
}

async function generateJsonFiles() {
    const csvData = await fs.readFile(CSV_FILE, 'utf8');
    const companies = parse(csvData, { columns: true, skip_empty_lines: true });

    for (const { TICKER: ticker, NAME: name } of companies) {
        const filePath = path.join(DATA_DIR, `${ticker}.json`);
        const companyName = name.toLowerCase().replace(/\s+/g, '');
        const defaultWebsite = COMPANY_WEBSITES[ticker] || `https://www.${companyName}.com`;

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
            resources_copper_mlb: 0,
            resources_zinc_mlb: 0,
            resources_manganese_mt: 0,
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
            reserve_boost_factor: 3,
            resources_detailed: [],
            mining_summary: {},
            company_website: defaultWebsite,
            resources_gold_moz_from_overview: 0,
            resources_silver_moz_from_overview: 0,
            last_updated_overview: null
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
            if (key === 'resources_detailed' || key === 'mining_summary') {
                fields.push(key);
                values.push(JSON.stringify(value));
                placeholders.push('?');
            } else {
                fields.push(key);
                values.push(value);
                placeholders.push('?');
            }
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

async function updateJsonWithOverviewData(directory) {
    const files = await fs.readdir(directory);
    for (const file of files) {
        if (path.extname(file) === '.json') {
            const filePath = path.join(directory, file);
            const ticker = path.basename(file, '.json');
            try {
                const content = await fs.readFile(filePath, 'utf8');
                let data = JSON.parse(content);

                const overviewData = await fetchOverviewData(ticker);
                if (overviewData) {
                    data.resources_gold_moz_from_overview = overviewData.resources_gold_moz_from_overview;
                    data.resources_silver_moz_from_overview = overviewData.resources_silver_moz_from_overview;
                    data.last_updated_overview = overviewData.last_updated_overview;

                    if (data.resources_gold_moz_from_overview > 0) {
                        data.resources_gold_moz = data.resources_gold_moz_from_overview;
                    }
                    if (data.resources_silver_moz_from_overview > 0) {
                        data.resources_silver_moz = data.resources_silver_moz_from_overview;
                    }

                    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
                    console.log(`Updated ${ticker}.json with overview data`);
                }
            } catch (err) {
                console.error(`Failed to process overview data for ${ticker}: ${err.message}`);
            }
        }
    }
}

async function processDirectory(directory) {
    try {
        await updateJsonWithOverviewData(directory);

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