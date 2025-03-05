const yahooFinance = require('yahoo-finance2').default;
yahooFinance.suppressNotices(['yahooSurvey']);
const axios = require('axios');
const fs = require('fs').promises;
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3').verbose();

const CSV_FILE = 'public/data/companies.csv';
const LOG_FILE = 'financial_population_log.txt';
const ALPHA_VANTAGE_KEY = 'BIV80TT696VJIUL2';
const CALLS_PER_MINUTE = 4.5;
const DELAY_BETWEEN_CALLS = Math.ceil(60000 / CALLS_PER_MINUTE); // ~13.3 seconds
const MAX_RETRIES = 3;
const CAD_THRESHOLD = 0.02;

const db = new sqlite3.Database('./mining_companies.db', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to database for financial population.');
});

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchYahooFinancials(ticker) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const quote = await yahooFinance.quoteSummary(ticker, { modules: ['financialData', 'incomeStatementHistory'] });
      const financials = quote.financialData || {};
      const income = quote.incomeStatementHistory?.incomeStatementHistory[0] || {};
      return {
        cash_value: financials.totalCash || null,
        debt_value: financials.totalDebt || null,
        enterprise_value_value: quote.defaultKeyStatistics?.enterpriseValue || null,
        revenue_value: income.totalRevenue || null,
        net_income_value: income.netIncome || null,
        currency_cash: 'USD',
        currency_debt: 'USD',
        currency_enterprise: 'CAD',
        currency_revenue: 'USD',
        currency_net_income: 'USD'
      };
    } catch (e) {
      console.error(`Yahoo fetch attempt ${attempt + 1} failed for ${ticker}:`, e.message);
      if (e.response) {
        console.error('Status:', e.response.status);
        console.error('Data:', e.response.data);
      }
      if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt));
    }
  }
  console.error(`Yahoo fetch exhausted retries for ${ticker}`);
  return null;
}

async function fetchAlphaVantageFinancials(ticker) {
  const baseUrl = 'https://www.alphavantage.co/query';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const balanceSheet = await axios.get(`${baseUrl}?function=BALANCE_SHEET&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`);
      const incomeStatement = await axios.get(`${baseUrl}?function=INCOME_STATEMENT&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`);
      
      const latestBalance = balanceSheet.data.annualReports?.[0] || {};
      const latestIncome = incomeStatement.data.annualReports?.[0] || {};
      
      return {
        cash_value: latestBalance.cashAndCashEquivalentsAtCarryingValue ? parseFloat(latestBalance.cashAndCashEquivalentsAtCarryingValue) : null,
        debt_value: latestBalance.longTermDebt ? parseFloat(latestBalance.longTermDebt) : null,
        enterprise_value_value: null, // Alpha Vantage doesn’t provide this
        revenue_value: latestIncome.totalRevenue ? parseFloat(latestIncome.totalRevenue) : null,
        net_income_value: latestIncome.netIncome ? parseFloat(latestIncome.netIncome) : null,
        currency_cash: 'USD',
        currency_debt: 'USD',
        currency_enterprise: null,
        currency_revenue: 'USD',
        currency_net_income: 'USD'
      };
    } catch (e) {
      console.error(`Alpha Vantage fetch attempt ${attempt + 1} failed for ${ticker}:`, e.message);
      if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt));
    }
  }
  console.error(`Alpha Vantage fetch exhausted retries for ${ticker}`);
  return null;
}

async function resolveData(ticker, yahooData, alphaData) {
  const fields = [
    { key: 'cash_value', currency: 'USD' },
    { key: 'debt_value', currency: 'USD' },
    { key: 'enterprise_value_value', currency: 'CAD' },
    { key: 'revenue_value', currency: 'USD' },
    { key: 'net_income_value', currency: 'USD' }
  ];
  const resolved = {};
  const log = [`[${new Date().toISOString()}] ${ticker}`];
  const exchangeRates = { 'USD': 1.35, 'CAD': 1.0, 'AUD': 0.90 };

  fields.forEach(({ key, currency }) => {
    const yahooValue = yahooData ? yahooData[key] : null;
    const alphaValue = alphaData ? alphaData[key] : null;
    const sources = [
      { name: 'Yahoo', value: yahooValue, currency: yahooData ? yahooData[`currency_${key.split('_')[0]}`] : null },
      { name: 'Alpha', value: alphaValue, currency: alphaData ? alphaData[`currency_${key.split('_')[0]}`] : null }
    ].filter(s => s.value !== null);

    if (sources.length === 0) {
      resolved[key] = 0;
      log.push(`${key}: No data, defaulting to 0 ${currency}`);
    } else if (sources.length === 1) {
      resolved[key] = sources[0].value;
      log.push(`${key}: ${sources[0].name}=${sources[0].value} ${sources[0].currency}, Resolved=${resolved[key]} ${currency}`);
    } else {
      const variance = Math.max(...sources.map(s1 => Math.max(...sources.map(s2 => Math.abs(s1.value - s2.value)))));
      if (variance > CAD_THRESHOLD * (key.includes('value') ? 1e6 : 1)) {
        console.warn(`High ${key} variance for ${ticker}: ${sources.map(s => `${s.name}=${s.value} ${s.currency}`).join(', ')}`);
        resolved[key] = yahooValue || alphaValue; // Prefer Yahoo if available
      } else {
        resolved[key] = sources.reduce((sum, s) => sum + s.value, 0) / sources.length;
      }
      log.push(`${key}: ${sources.map(s => `${s.name}=${s.value} ${s.currency}`).join(', ')}, Variance=${variance.toFixed(2)}, Resolved=${resolved[key].toFixed(0)} ${currency}`);
    }
    resolved[`${key.split('_')[0]}_currency`] = currency;

    const cadKey = key.replace('_value', '_cad');
    if (resolved[key]) {
      const rate = exchangeRates[currency] || 1;
      resolved[cadKey] = resolved[key] * rate;
    } else {
      resolved[cadKey] = 0;
    }
  });

  await fs.appendFile(LOG_FILE, log.join('\n') + '\n');
  return resolved;
}

async function updateDatabase(ticker, data) {
  const fields = [
    'cash_value', 'cash_currency', 'cash_cad',
    'debt_value', 'debt_currency', 'debt_cad',
    'enterprise_value_value', 'enterprise_value_currency', 'enterprise_value_cad',
    'revenue_value', 'revenue_currency', 'revenue_cad',
    'net_income_value', 'net_income_currency', 'net_income_cad',
    'last_updated'
  ];
  const updateFields = fields.map(field => `${field} = ?`).join(', ');
  const values = fields.map(field => data[field] || (field === 'last_updated' ? new Date().toISOString() : 0));
  values.push(ticker);

  const sql = `UPDATE companies SET ${updateFields} WHERE tsx_code = ?`;
  return new Promise((resolve, reject) => {
    db.run(sql, values, function(err) {
      if (err) {
        console.error(`Error updating ${ticker}: ${err.message}`);
        reject(err);
      } else {
        console.log(`Updated financials for ${ticker} in database`);
        resolve();
      }
    });
  });
}

async function main() {
  try {
    const csvData = await fs.readFile(CSV_FILE, 'utf8');
    const cleanedCsvData = csvData.trim().replace(/^\ufeff/, '');
    const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });
    console.log(`Parsed ${companies.length} companies from CSV:`);
    console.log(companies.map(c => c.TICKER).join(', '));

    for (const company of companies) {
      const ticker = company.TICKER;
      if (!ticker || ticker === 'undefined') {
        console.error(`Invalid ticker found: ${JSON.stringify(company)}`);
        await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Skipping invalid ticker: ${JSON.stringify(company)}\n`);
        continue;
      }
      console.log(`Processing ${ticker}`);

      let yahooData = null;
      try {
        yahooData = await fetchYahooFinancials(ticker);
      } catch (e) {
        console.error(`Failed to fetch Yahoo data for ${ticker}:`, e.message);
      }
      await delay(DELAY_BETWEEN_CALLS);

      const alphaData = await fetchAlphaVantageFinancials(ticker);

      const resolvedData = await resolveData(ticker, yahooData, alphaData);
      await updateDatabase(ticker, resolvedData);

      console.log(`Updated ${ticker} with financials`);
      await delay(DELAY_BETWEEN_CALLS);
    }
  } catch (err) {
    console.error('Main failed:', err);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Main failed: ${err.message}\n`);
  } finally {
    db.close();
  }
}

main();