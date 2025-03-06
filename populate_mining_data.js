
const ALPHA_VANTAGE_KEY = 'BIV80TT696VJIUL2';           // Replace with your Alpha Vantage API key
// Required dependencies
// Required dependencies
const yahooFinance = require('yahoo-finance2').default; // For Yahoo Finance API
const axios = require('axios'); // For making HTTP requests to Alpha Vantage
const fs = require('fs').promises; // For file operations (CSV reading, logging)
const { parse } = require('csv-parse/sync'); // For parsing CSV files
const sqlite3 = require('sqlite3').verbose(); // SQLite database client with verbose mode

// Configuration constants
const CSV_FILE = 'public/data/companies.csv'; // Path to companies CSV file
const LOG_FILE = 'financial_population_log.txt'; // Log file for debugging and auditing

const MAX_RETRIES = 3; // Maximum retries for API calls
const DELAY_BETWEEN_CALLS = 15000; // 15-second delay to respect API rate limits (Alpha Vantage: 5 calls/min)
const CAD_THRESHOLD = 0.05; // 5% threshold for cross-verification discrepancies

// Initialize SQLite database connection with error handling
const db = new sqlite3.Database('./mining_companies.db', (err) => {
  if (err) {
    console.error(`[ERROR] Database connection failed: ${err.message}`);
    process.exit(1); // Exit if connection fails to prevent further execution
  } else {
    console.log('[INFO] Successfully connected to the database.');
  }
});

// Cache for exchange rates to avoid redundant API calls
const exchangeRatesCache = {};

/**
 * Introduces a delay to respect API rate limits and logs the action.
 * @param {number} ms - Delay duration in milliseconds.
 * @param {string} [message='Delaying'] - Descriptive message for logging.
 * @returns {Promise<void>}
 */
async function delay(ms, message = 'Delaying') {
  const logMessage = `[${new Date().toISOString()}] [INFO] ${message} for ${ms / 1000} seconds`;
  console.log(logMessage);
  await fs.appendFile(LOG_FILE, `${logMessage}\n`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetches the exchange rate between two currencies from Alpha Vantage and caches it.
 * @param {string} fromCurrency - Source currency (e.g., 'USD').
 * @param {string} toCurrency - Target currency (e.g., 'CAD').
 * @returns {Promise<number>} - Exchange rate, defaults to 1 if fetch fails.
 */
async function getExchangeRate(fromCurrency, toCurrency) {
  const key = `${fromCurrency}_${toCurrency}`;
  if (exchangeRatesCache[key]) {
    console.log(`[INFO] Using cached exchange rate for ${key}: ${exchangeRatesCache[key]}`);
    return exchangeRatesCache[key];
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(
        `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${fromCurrency}&to_currency=${toCurrency}&apikey=${ALPHA_VANTAGE_KEY}`
      );
      const rate = response.data['Realtime Currency Exchange Rate']['5. Exchange Rate'];
      if (!rate) throw new Error('Invalid exchange rate response');
      
      exchangeRatesCache[key] = parseFloat(rate);
      console.log(`[INFO] Fetched exchange rate for ${key}: ${exchangeRatesCache[key]}`);
      return exchangeRatesCache[key];
    } catch (e) {
      console.error(`[ERROR] Attempt ${attempt + 1} failed to fetch exchange rate for ${key}: ${e.message}`);
      if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt), `Retrying exchange rate fetch for ${key}`);
    }
  }
  
  console.error(`[ERROR] Exhausted retries for exchange rate ${key}, defaulting to 1`);
  return 1; // Fallback to no conversion if all retries fail
}

/**
 * Converts a monetary value to CAD using the appropriate exchange rate.
 * @param {number} value - Value to convert.
 * @param {string} currency - Currency of the value.
 * @returns {Promise<number>} - Converted value in CAD.
 */
async function convertToCAD(value, currency) {
  if (!value || currency === 'CAD') return value || 0;
  const rate = await getExchangeRate(currency, 'CAD');
  const converted = value * rate;
  console.log(`[INFO] Converted ${value} ${currency} to ${converted} CAD (rate: ${rate})`);
  return converted;
}

/**
 * Fetches financial data from Yahoo Finance with retry logic.
 * @param {string} ticker - Company ticker symbol (e.g., 'AAB.TO').
 * @returns {Promise<Object|null>} - Financial data or null if all retries fail.
 */
async function fetchYahooData(ticker) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const quote = await yahooFinance.quoteSummary(ticker, {
        modules: ['price', 'defaultKeyStatistics', 'financialData', 'incomeStatementHistory']
      });
      const priceData = quote.price || {};
      const statsData = quote.defaultKeyStatistics || {};
      const financialData = quote.financialData || {};
      const incomeData = quote.incomeStatementHistory?.incomeStatementHistory[0] || {};

      const data = {
        stock_price: priceData.regularMarketPrice,
        stock_price_currency: priceData.currency || 'CAD', // TSX companies typically in CAD
        number_of_shares: statsData.sharesOutstanding,
        market_cap_value: priceData.marketCap,
        market_cap_currency: priceData.currency || 'CAD',
        cash_value: financialData.totalCash,
        cash_currency: financialData.currency || 'USD',
        debt_value: financialData.totalDebt,
        debt_currency: financialData.currency || 'USD',
        enterprise_value_value: statsData.enterpriseValue,
        enterprise_value_currency: priceData.currency || 'CAD',
        revenue_value: incomeData.totalRevenue,
        revenue_currency: incomeData.currency || 'USD',
        net_income_value: incomeData.netIncome,
        net_income_currency: incomeData.currency || 'USD'
      };
      
      console.log(`[INFO] Successfully fetched Yahoo Finance data for ${ticker}:`, JSON.stringify(data));
      return data;
    } catch (e) {
      console.error(`[ERROR] Yahoo fetch attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
      if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt), `Retrying Yahoo fetch for ${ticker}`);
    }
  }
  
  console.error(`[ERROR] Exhausted retries for Yahoo Finance fetch for ${ticker}`);
  return null;
}

/**
 * Fetches financial data from Alpha Vantage with error handling.
 * @param {string} ticker - Company ticker symbol.
 * @returns {Promise<Object>} - Financial data (partial if some calls fail).
 */
async function fetchAlphaVantageData(ticker) {
  const baseUrl = 'https://www.alphavantage.co/query';
  const data = {};

  // Fetch stock price
  try {
    const quoteResponse = await axios.get(`${baseUrl}?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`);
    const quoteData = quoteResponse.data['Global Quote'];
    if (quoteData && quoteData['05. price']) {
      data.stock_price = parseFloat(quoteData['05. price']);
      data.stock_price_currency = 'CAD'; // Assuming CAD for TSX-listed companies
      console.log(`[INFO] Fetched Alpha Vantage stock price for ${ticker}: ${data.stock_price} ${data.stock_price_currency}`);
    }
  } catch (e) {
    console.warn(`[WARN] Failed to fetch Alpha Vantage stock price for ${ticker}: ${e.message}`);
  }

  // Fetch balance sheet data (cash and debt)
  try {
    const balanceResponse = await axios.get(`${baseUrl}?function=BALANCE_SHEET&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`);
    const balanceData = balanceResponse.data.annualReports?.[0];
    if (balanceData) {
      data.cash_value = parseFloat(balanceData.cashAndCashEquivalentsAtCarryingValue) || 0;
      data.cash_currency = 'USD';
      data.debt_value = parseFloat(balanceData.longTermDebt) || 0;
      data.debt_currency = 'USD';
      console.log(`[INFO] Fetched Alpha Vantage balance sheet for ${ticker}: Cash ${data.cash_value}, Debt ${data.debt_value}`);
    }
  } catch (e) {
    console.warn(`[WARN] Failed to fetch Alpha Vantage balance sheet for ${ticker}: ${e.message}`);
  }

  // Fetch income statement data (revenue and net income)
  try {
    const incomeResponse = await axios.get(`${baseUrl}?function=INCOME_STATEMENT&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`);
    const incomeData = incomeResponse.data.annualReports?.[0];
    if (incomeData) {
      data.revenue_value = parseFloat(incomeData.totalRevenue) || 0;
      data.revenue_currency = 'USD';
      data.net_income_value = parseFloat(incomeData.netIncome) || 0;
      data.net_income_currency = 'USD';
      console.log(`[INFO] Fetched Alpha Vantage income statement for ${ticker}: Revenue ${data.revenue_value}, Net Income ${data.net_income_value}`);
    }
  } catch (e) {
    console.warn(`[WARN] Failed to fetch Alpha Vantage income statement for ${ticker}: ${e.message}`);
  }

  return data;
}

/**
 * Cross-verifies data from Yahoo Finance and Alpha Vantage, preferring Yahoo when available.
 * @param {Object|null} yahooData - Data from Yahoo Finance.
 * @param {Object} alphaData - Data from Alpha Vantage.
 * @returns {Object} - Verified and consolidated financial data.
 */
function crossVerifyData(yahooData, alphaData) {
  const verified = {};

  // Helper function to log discrepancies
  const logDiscrepancy = (field, yahooValue, alphaValue, threshold = CAD_THRESHOLD) => {
    if (yahooValue && alphaValue && Math.abs(yahooValue - alphaValue) / Math.max(yahooValue, alphaValue) > threshold) {
      console.warn(`[WARN] Discrepancy in ${field}: Yahoo=${yahooValue}, Alpha=${alphaValue}`);
    }
  };

  // Stock price
  verified.stock_price = yahooData?.stock_price ?? alphaData?.stock_price ?? 0;
  verified.stock_price_currency = yahooData?.stock_price_currency ?? alphaData?.stock_price_currency ?? 'CAD';
  logDiscrepancy('stock_price', yahooData?.stock_price, alphaData?.stock_price);

  // Number of shares (Yahoo only, as Alpha Vantage doesn't provide this directly)
  verified.number_of_shares = yahooData?.number_of_shares ?? 0;

  // Market capitalization
  verified.market_cap_value = yahooData?.market_cap_value ?? (verified.stock_price * verified.number_of_shares) ?? 0;
  verified.market_cap_currency = yahooData?.market_cap_currency ?? verified.stock_price_currency;

  // Cash
  verified.cash_value = yahooData?.cash_value ?? alphaData?.cash_value ?? 0;
  verified.cash_currency = yahooData?.cash_currency ?? alphaData?.cash_currency ?? 'USD';
  logDiscrepancy('cash_value', yahooData?.cash_value, alphaData?.cash_value);

  // Debt
  verified.debt_value = yahooData?.debt_value ?? alphaData?.debt_value ?? 0;
  verified.debt_currency = yahooData?.debt_currency ?? alphaData?.debt_currency ?? 'USD';
  logDiscrepancy('debt_value', yahooData?.debt_value, alphaData?.debt_value);

  // Enterprise value
  verified.enterprise_value_value = yahooData?.enterprise_value_value ?? 
    (verified.market_cap_value + verified.debt_value - verified.cash_value) ?? 0;
  verified.enterprise_value_currency = yahooData?.enterprise_value_currency ?? verified.market_cap_currency;

  // Revenue
  verified.revenue_value = yahooData?.revenue_value ?? alphaData?.revenue_value ?? 0;
  verified.revenue_currency = yahooData?.revenue_currency ?? alphaData?.revenue_currency ?? 'USD';
  logDiscrepancy('revenue_value', yahooData?.revenue_value, alphaData?.revenue_value);

  // Net income
  verified.net_income_value = yahooData?.net_income_value ?? alphaData?.net_income_value ?? 0;
  verified.net_income_currency = yahooData?.net_income_currency ?? alphaData?.net_income_currency ?? 'USD';
  logDiscrepancy('net_income_value', yahooData?.net_income_value, alphaData?.net_income_value);

  console.log(`[INFO] Verified data for cross-verification:`, JSON.stringify(verified));
  return verified;
}

/**
 * Updates the companies table in the database with verified financial data.
 * @param {string} ticker - Company ticker symbol.
 * @param {Object} data - Verified financial data.
 * @returns {Promise<void>}
 */
async function updateDatabase(ticker, data) {
  // Prepare all values, including CAD conversions
  const values = [
    data.stock_price,
    data.stock_price_currency,
    data.number_of_shares,
    data.market_cap_value,
    data.market_cap_currency,
    data.cash_value,
    data.cash_currency,
    data.debt_value,
    data.debt_currency,
    data.enterprise_value_value,
    data.enterprise_value_currency,
    data.revenue_value,
    data.revenue_currency,
    data.net_income_value,
    data.net_income_currency,
    new Date().toISOString(), // last_updated
    await convertToCAD(data.market_cap_value, data.market_cap_currency),
    await convertToCAD(data.cash_value, data.cash_currency),
    await convertToCAD(data.debt_value, data.debt_currency),
    await convertToCAD(data.enterprise_value_value, data.enterprise_value_currency),
    await convertToCAD(data.revenue_value, data.revenue_currency),
    await convertToCAD(data.net_income_value, data.net_income_currency)
  ];

  const sql = `
    UPDATE companies 
    SET 
      stock_price = ?, stock_price_currency = ?,
      number_of_shares = ?,
      market_cap_value = ?, market_cap_currency = ?,
      cash_value = ?, cash_currency = ?,
      debt_value = ?, debt_currency = ?,
      enterprise_value_value = ?, enterprise_value_currency = ?,
      revenue_value = ?, revenue_currency = ?,
      net_income_value = ?, net_income_currency = ?,
      last_updated = ?,
      market_cap_cad = ?,
      cash_cad = ?,
      debt_cad = ?,
      enterprise_value_cad = ?,
      revenue_cad = ?,
      net_income_cad = ?
    WHERE tsx_code = ?
  `;

  return new Promise((resolve, reject) => {
    db.run(sql, [...values, ticker], async function(err) {
      if (err) {
        const errorMsg = `[ERROR] Failed to update database for ${ticker}: ${err.message}`;
        console.error(errorMsg);
        await fs.appendFile(LOG_FILE, `${errorMsg}\n`);
        reject(err);
      } else {
        const successMsg = `[INFO] Successfully updated database for ${ticker}`;
        console.log(successMsg);
        await fs.appendFile(LOG_FILE, `${successMsg}\n`);
        resolve();
      }
    });
  });
}

/**
 * Main function to orchestrate the population of the companies table.
 */
async function main() {
  try {
    // Read and parse the CSV file
    const csvData = await fs.readFile(CSV_FILE, 'utf8');
    const cleanedCsvData = csvData.trim().replace(/^\ufeff/, ''); // Remove BOM if present at the start
    const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });

    // Clean BOM from all keys in each company object
    companies.forEach(company => {
      Object.keys(company).forEach(key => {
        const cleanedKey = key.replace(/^\ufeff/, '');
        if (cleanedKey !== key) {
          company[cleanedKey] = company[key];
          delete company[key];
          console.log(`[INFO] Cleaned BOM from key '${key}' to '${cleanedKey}' for company: ${JSON.stringify(company)}`);
        }
      });
    });

    console.log(`[INFO] Parsed ${companies.length} companies from CSV: ${companies.map(c => c.TICKER).join(', ')}`);

    // Process each company
    for (const company of companies) {
      const ticker = company.TICKER;
      if (!ticker) {
        console.warn(`[WARN] Skipping entry with missing ticker: ${JSON.stringify(company)}`);
        continue;
      }

      console.log(`\n=== Processing ${ticker} ===`);

      // Fetch data from both sources
      const yahooData = await fetchYahooData(ticker);
      await delay(DELAY_BETWEEN_CALLS, `Pausing after Yahoo fetch for ${ticker}`);

      const alphaData = await fetchAlphaVantageData(ticker);
      await delay(DELAY_BETWEEN_CALLS, `Pausing after Alpha Vantage fetch for ${ticker}`);

      // Verify and consolidate data
      const verifiedData = crossVerifyData(yahooData, alphaData);

      // Update the database
      await updateDatabase(ticker, verifiedData);

      console.log(`[INFO] Completed processing ${ticker}`);
    }

    console.log('[INFO] All companies processed successfully.');
  } catch (err) {
    const errorMsg = `[ERROR] Main execution failed: ${err.message}`;
    console.error(errorMsg);
    await fs.appendFile(LOG_FILE, `${errorMsg}\n`);
  } finally {
    db.close((err) => {
      if (err) console.error(`[ERROR] Failed to close database: ${err.message}`);
      else console.log('[INFO] Database connection closed.');
    });
  }
}

// Run the script
main();