const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const fetch = require('node-fetch');
const app = express();
const port = 3000;

const FMP_API_KEY = 'zUCYoFU4JoWsdWZlChltufkaWgKdBIUv'; // Ensure this key is valid
const ALPHA_VANTAGE_API_KEY = 'yP9S0H9BKHQYOOE3U'; // Replace with your Alpha Vantage API key

// Connect to SQLite database
const db = new sqlite3.Database('./mining_companies.db', (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
        // Create companies table
        db.run(`CREATE TABLE IF NOT EXISTS companies (
            company_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            tsx_code TEXT UNIQUE,
            description TEXT,
            stock_price REAL,
            stock_price_currency TEXT,
            last_updated TEXT,
            number_of_shares INTEGER,
            market_cap_value REAL,
            market_cap_currency TEXT,
            market_cap_cad REAL,
            cash_value REAL,
            cash_currency TEXT,
            cash_cad REAL,
            debt_value REAL,
            debt_currency TEXT,
            debt_cad REAL,
            enterprise_value_value REAL,
            enterprise_value_currency TEXT,
            enterprise_value_cad REAL,
            revenue_value REAL,
            revenue_currency TEXT,
            revenue_cad REAL,
            net_income_value REAL,
            net_income_currency TEXT,
            net_income_cad REAL,
            reserves_au_moz REAL,
            resources_au_moz REAL,
            production_total_au_eq_koz REAL,
            aisc_last_year_value REAL,
            aisc_last_year_currency TEXT,
            news_link TEXT
        )`);

        // Create exchange_rates table
        db.run(`CREATE TABLE IF NOT EXISTS exchange_rates (
            currency TEXT PRIMARY KEY,
            rate_to_cad REAL,
            last_updated TEXT
        )`, (err) => {
            if (err) {
                console.error('Error creating exchange_rates table:', err);
            } else {
                // Insert default exchange rates if table is empty
                db.get('SELECT COUNT(*) as count FROM exchange_rates', (err, row) => {
                    if (err) {
                        console.error('Error checking exchange_rates:', err);
                    } else if (row.count === 0) {
                        const defaultRates = [
                            ['USD', 1.35, new Date().toISOString()], // Example USD to CAD rate
                            ['AUD', 0.90, new Date().toISOString()]  // Example AUD to CAD rate
                        ];
                        db.run(
                            `INSERT INTO exchange_rates (currency, rate_to_cad, last_updated) VALUES (?, ?, ?)`,
                            defaultRates[0]
                        );
                        db.run(
                            `INSERT INTO exchange_rates (currency, rate_to_cad, last_updated) VALUES (?, ?, ?)`,
                            defaultRates[1]
                        );
                        console.log('Initialized exchange_rates with default values.');
                    }
                });
            }
        });
    }
});

app.use(express.json());
app.use(express.static('public'));

// Fetch and update exchange rates
async function updateExchangeRates() {
    try {
        const currencies = ['USD', 'AUD'];
        for (const currency of currencies) {
            const res = await fetch(
                `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${currency}&to_currency=CAD&apikey=${ALPHA_VANTAGE_API_KEY}`
            );
            const data = await res.json();
            const rate = parseFloat(data['Realtime Currency Exchange Rate']['5. Exchange Rate']);
            const lastUpdated = new Date().toISOString();
            db.run(
                `INSERT OR REPLACE INTO exchange_rates (currency, rate_to_cad, last_updated) VALUES (?, ?, ?)`,
                [currency, rate, lastUpdated]
            );
        }
        console.log('Exchange rates updated.');
    } catch (error) {
        console.error('Error updating exchange rates:', error);
    }
}

// Fetch and update stock prices and financial data
async function updateCompanyData() {
    try {
        const companies = await new Promise((resolve, reject) => {
            db.all('SELECT tsx_code FROM companies', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        const exchangeRates = await new Promise((resolve, reject) => {
            db.all('SELECT currency, rate_to_cad FROM exchange_rates', [], (err, rows) => {
                if (err) reject(err);
                else resolve(Object.fromEntries(rows.map(row => [row.currency, row.rate_to_cad])));
            });
        });

        for (const company of companies) {
            const ticker = company.tsx_code.replace('.TO', '');
            const [profileRes, incomeRes, balanceRes] = await Promise.all([
                fetch(`https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_API_KEY}`),
                fetch(`https://financialmodelingprep.com/api/v3/income-statement/${ticker}?limit=1&apikey=${FMP_API_KEY}`),
                fetch(`https://financialmodelingprep.com/api/v3/balance-sheet-statement/${ticker}?limit=1&apikey=${FMP_API_KEY}`)
            ]);

            const profile = await profileRes.json();
            const income = await incomeRes.json();
            const balance = await balanceRes.json();

            const profileData = profile[0] || {};
            const incomeData = income[0] || {};
            const balanceData = balance[0] || {};

            const currency = profileData.currency || 'CAD';
            const exchangeRate = currency === 'CAD' ? 1 : exchangeRates[currency] || 1.35; // Default to 1.35 if rate unavailable

            const stockPrice = parseFloat(profileData.price) || 0;
            const marketCapValue = parseFloat(profileData.mktCap) || 0;
            const cashValue = parseFloat(balanceData.cashAndEquivalents) || 0;
            const debtValue = parseFloat(balanceData.totalDebt) || 0;
            const revenueValue = parseFloat(incomeData.revenue) || 0;
            const netIncomeValue = parseFloat(incomeData.netIncome) || 0;

            const marketCapCAD = marketCapValue / 1e6 * exchangeRate;
            const cashCAD = cashValue / 1e6 * exchangeRate;
            const debtCAD = debtValue / 1e6 * exchangeRate;
            const enterpriseValueCAD = marketCapCAD + debtCAD - cashCAD;
            const revenueCAD = revenueValue / 1e6 * exchangeRate;
            const netIncomeCAD = netIncomeValue / 1e6 * exchangeRate;

            const lastUpdated = new Date().toISOString();

            db.run(
                `UPDATE companies SET 
                    stock_price = ?, stock_price_currency = ?, last_updated = ?,
                    market_cap_value = ?, market_cap_currency = ?, market_cap_cad = ?,
                    cash_value = ?, cash_currency = ?, cash_cad = ?,
                    debt_value = ?, debt_currency = ?, debt_cad = ?,
                    enterprise_value_value = ?, enterprise_value_currency = ?, enterprise_value_cad = ?,
                    revenue_value = ?, revenue_currency = ?, revenue_cad = ?,
                    net_income_value = ?, net_income_currency = ?, net_income_cad = ?
                WHERE tsx_code = ?`,
                [
                    stockPrice, currency, lastUpdated,
                    marketCapValue, currency, marketCapCAD,
                    cashValue, currency, cashCAD,
                    debtValue, currency, debtCAD,
                    enterpriseValueCAD / exchangeRate * 1e6, currency, enterpriseValueCAD,
                    revenueValue, currency, revenueCAD,
                    netIncomeValue, currency, netIncomeCAD,
                    company.tsx_code
                ]
            );
        }
        console.log('Company data updated.');
    } catch (error) {
        console.error('Error updating company data:', error);
    }
}

// Schedule updates every 12 hours
cron.schedule('0 */12 * * *', () => {
    updateExchangeRates();
    updateCompanyData();
});

// API endpoint for front-end
app.get('/api/data', (req, res) => {
    db.all(
        `SELECT name, tsx_code, stock_price, market_cap_cad, enterprise_value_cad AS ev, 
                reserves_au_moz AS reserves, resources_au_moz AS resources, 
                aisc_last_year_value AS aisc, revenue_cad AS revenue, net_income_cad AS profit, 
                news_link AS news, production_total_au_eq_koz AS production
         FROM companies`,
        [], (err, rows) => {
            if (err) {
                res.status(500).json({ error: 'Failed to fetch data' });
                return;
            }
            const allData = rows.map(row => {
                const evPerOz = row.reserves > 0 ? row.ev / row.reserves : null;
                const marketCapPerOz = row.reserves > 0 ? row.market_cap_cad / row.reserves : null;
                return { ...row, evPerOz, marketCapPerOz };
            });
            res.json(allData);
        }
    );
});

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});