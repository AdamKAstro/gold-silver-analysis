const yahooFinance = require('yahoo-finance2').default;
yahooFinance.suppressNotices(['yahooSurvey']); // Suppress survey notice early
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';
const LOG_FILE = 'financial_population_log.txt';
const ALPHA_VANTAGE_KEY = 'BIV80TT696VJIUL2';
const CALLS_PER_MINUTE = 4.5; // Stay under 5 calls/minute
const DELAY_BETWEEN_CALLS = Math.ceil(60000 / CALLS_PER_MINUTE); // ~13.33s
const MAX_RETRIES = 3; // Retries per API call
const CAD_THRESHOLD = 0.02; // Variance threshold for merging

// Helper function for delays
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch from Yahoo Finance
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
      console.error(`Yahoo fetch attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
      if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt)); // Exponential backoff
    }
  }
  console.error(`Yahoo fetch exhausted retries for ${ticker}`);
  return null;
}

// Fetch from Alpha Vantage
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
        enterprise_value_value: null, // Alpha Vantage doesn’t provide this directly
        revenue_value: latestIncome.totalRevenue ? parseFloat(latestIncome.totalRevenue) : null,
        net_income_value: latestIncome.netIncome ? parseFloat(latestIncome.netIncome) : null,
        currency_cash: 'USD',
        currency_debt: 'USD',
        currency_enterprise: null,
        currency_revenue: 'USD',
        currency_net_income: 'USD'
      };
    } catch (e) {
      console.error(`Alpha Vantage fetch attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
      if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt));
    }
  }
  console.error(`Alpha Vantage fetch exhausted retries for ${ticker}`);
  return null;
}

// Resolve data from multiple sources
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

  fields.forEach(({ key, currency }) => {
    const sources = [
      { name: 'Yahoo', value: yahooData ? yahooData[key] : null, currency: yahooData ? yahooData[`currency_${key.split('_')[0]}`] : null },
      { name: 'Alpha', value: alphaData ? alphaData[key] : null, currency: alphaData ? alphaData[`currency_${key.split('_')[0]}`] : null }
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
        resolved[key] = yahooData[key] || sources[0].value; // Prefer Yahoo
      } else {
        resolved[key] = sources.reduce((sum, s) => sum + s.value, 0) / sources.length;
      }
      log.push(`${key}: ${sources.map(s => `${s.name}=${s.value} ${s.currency}`).join(', ')}, Variance=${variance.toFixed(2)}, Resolved=${resolved[key].toFixed(0)} ${currency}`);
    }
    resolved[`${key.split('_')[0]}_currency`] = currency;
  });

  await fs.appendFile(LOG_FILE, log.join('\n') + '\n');
  return resolved;
}

// Update existing JSON file
async function updateJsonFile(ticker, data) {
  const filePath = path.join(DATA_DIR, `${ticker}.json`);
  let jsonData;
  try {
    jsonData = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (e) {
    jsonData = { name: ticker, tsx_code: ticker }; // Minimal fallback
  }
  Object.assign(jsonData, data, { last_updated_financials: new Date().toISOString() });
  await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
}

// Main function
async function main() {
  try {
    const csvData = await fs.readFile(CSV_FILE, 'utf8');
    const cleanedCsvData = csvData.trim().replace(/^\ufeff/, ''); // Remove BOM and trim
    const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });
    console.log(`Parsed ${companies.length} companies from CSV:`);
    console.log(companies.map(c => c.TICKER).join(', ')); // Log tickers for verification

    for (const company of companies) {
      const ticker = company.TICKER;
      if (!ticker || ticker === 'undefined') {
        console.error(`Invalid ticker found: ${JSON.stringify(company)}`);
        await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Skipping invalid ticker: ${JSON.stringify(company)}\n`);
        continue;
      }
      console.log(`Processing ${ticker}`);

      // Fetch from Yahoo
      const yahooData = await fetchYahooFinancials(ticker);
      await delay(DELAY_BETWEEN_CALLS); // Spacing before Alpha Vantage

      // Fetch from Alpha Vantage
      const alphaData = await fetchAlphaVantageFinancials(ticker);

      // Resolve and update
      const resolvedData = await resolveData(ticker, yahooData, alphaData);
      await updateJsonFile(ticker, resolvedData);

      console.log(`Updated ${ticker} with financials`);
      await delay(DELAY_BETWEEN_CALLS); // Respect Alpha Vantage rate limit
    }
  } catch (err) {
    console.error('Main failed:', err);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Main failed: ${err.message}\n`);
  }
}

main();
