// Required dependencies
const yahooFinance = require('yahoo-finance2').default;
const axios = require('axios');
const fs = require('fs').promises;
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3').verbose();
const puppeteer = require('puppeteer');

// Configuration constants
const CSV_FILE = 'public/data/companies.csv';
const LOG_FILE = 'financial_population_log.txt';
const ALPHA_VANTAGE_KEY = 'BIV80TT696VJIUL2';
const MAX_RETRIES = 3;
const DELAY_BETWEEN_CALLS = 1500;
const CAD_THRESHOLD = 0.05;

// Flags to enable/disable data sources
const USE_TRADINGVIEW = true;   // Set to false to disable TradingView
const USE_ALPHA_VANTAGE = false; // Set to false to disable Alpha Vantage

// Initialize SQLite database
const db = new sqlite3.Database('./mining_companies.db', (err) => {
  if (err) {
    console.error(`[ERROR] Database connection failed: ${err.message}`);
    process.exit(1);
  }
  console.log('[INFO] Connected to database.');
});

// Cache for exchange rates
const exchangeRatesCache = {};

/**
 * Delays execution to respect API rate limits.
 */
async function delay(ms, message = 'Delaying') {
  const logMessage = `[${new Date().toISOString()}] [INFO] ${message} for ${ms / 1000} seconds`;
  console.log(logMessage);
  await fs.appendFile(LOG_FILE, `${logMessage}\n`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extracts exchange code from ticker.
 */
function getExchangeFromTicker(ticker) {
  if (ticker.endsWith('.TO')) return 'TSX';
  if (ticker.endsWith('.V')) return 'TSXV';
  if (ticker.endsWith('.CN')) return 'CSE';
  console.warn(`[WARN] Unknown ticker suffix for ${ticker}, defaulting to TSX`);
  return 'TSX';
}

/**
 * Fetches exchange rate, prioritizing database, then TradingView, then Alpha Vantage.
 */
async function getExchangeRate(fromCurrency, toCurrency) {
  const key = `${fromCurrency}_${toCurrency}`;
  if (exchangeRatesCache[key]) {
    console.log(`[INFO] Using cached exchange rate for ${key}: ${exchangeRatesCache[key]}`);
    return exchangeRatesCache[key];
  }

  // Ensure toCurrency is CAD
  if (toCurrency !== 'CAD') {
    console.warn(`[WARN] Only CAD conversions are supported. Requested ${toCurrency}, defaulting to CAD.`);
    toCurrency = 'CAD';
  }

  // 1. Database
  try {
    const rate = await new Promise((resolve, reject) => {
      db.get(
        `SELECT rate_to_cad FROM exchange_rates WHERE currency = ?`,
        [fromCurrency],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? parseFloat(row.rate_to_cad) : null);
        }
      );
    });
    if (rate && rate > 0) {
      exchangeRatesCache[key] = rate;
      console.log(`[INFO] Fetched exchange rate from database for ${key}: ${rate}`);
      return rate;
    }
    console.log(`[INFO] No valid exchange rate in database for ${key}, trying next source`);
  } catch (e) {
    console.error(`[ERROR] Database exchange rate fetch failed for ${key}: ${e.message}`);
  }

  // 2. TradingView (if enabled)
  if (USE_TRADINGVIEW) {
    try {
      const rate = await fetchExchangeRateFromTradingView(fromCurrency, toCurrency);
      if (rate) {
        exchangeRatesCache[key] = rate;
        console.log(`[INFO] Fetched exchange rate from TradingView for ${key}: ${rate}`);
        return rate;
      }
      console.log(`[INFO] No exchange rate from TradingView for ${key}, falling back`);
    } catch (e) {
      console.error(`[ERROR] TradingView exchange rate fetch failed for ${key}: ${e.message}`);
    }
  } else {
    console.log(`[INFO] TradingView disabled for exchange rate fetch for ${key}`);
  }

  // 3. Alpha Vantage (if enabled)
  if (USE_ALPHA_VANTAGE) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await axios.get(
          `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${fromCurrency}&to_currency=${toCurrency}&apikey=${ALPHA_VANTAGE_KEY}`
        );
        console.log(`[DEBUG] Alpha Vantage response for ${key}:`, JSON.stringify(response.data));
        const rate = parseFloat(response.data['Realtime Currency Exchange Rate']?.['5. Exchange Rate']);
        if (rate) {
          exchangeRatesCache[key] = rate;
          console.log(`[INFO] Fetched exchange rate from Alpha Vantage for ${key}: ${rate}`);
          return rate;
        }
        throw new Error('Invalid response');
      } catch (e) {
        console.error(`[ERROR] Alpha Vantage attempt ${attempt + 1} failed for ${key}: ${e.message}`);
        if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt), `Retrying Alpha Vantage for ${key}`);
      }
    }
  } else {
    console.log(`[INFO] Alpha Vantage disabled for exchange rate fetch for ${key}`);
  }

  // Hardcoded fallback
  const fallbackRate = fromCurrency === 'USD' ? 1.35 : 1.0;
  console.warn(`[WARN] All exchange rate sources failed for ${key}, using fallback rate: ${fallbackRate}`);
  exchangeRatesCache[key] = fallbackRate;
  return fallbackRate;
}

/**
 * Scrapes exchange rate from TradingView.
 */
async function fetchExchangeRateFromTradingView(fromCurrency, toCurrency) {
  const url = `https://www.tradingview.com/symbols/${fromCurrency}${toCurrency}/`;
  console.log(`[INFO] Scraping exchange rate from TradingView: ${url}`);
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const rate = await page.evaluate(() => {
      const selectors = [
        '.tv-symbol-price-quote__value',
        '.js-symbol-last',
        '.priceWrapper-ujadn3P8 span'
      ];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          const text = element.textContent.trim().replace(/[^0-9.]/g, '');
          return parseFloat(text);
        }
      }
      return null;
    });

    if (!rate || isNaN(rate)) throw new Error('Could not find exchange rate');
    return rate;
  } catch (e) {
    throw new Error(`Failed to scrape exchange rate: ${e.message}`);
  } finally {
    await browser.close();
  }
}

/**
 * Converts a value to CAD.
 */
async function convertToCAD(value, currency) {
  if (!value || currency === 'CAD') return value || 0;
  const rate = await getExchangeRate(currency, 'CAD');
  const converted = value * rate;
  console.log(`[INFO] Converted ${value} ${currency} to ${converted} CAD (rate: ${rate})`);
  return converted;
}

/**
 * Fetches financial data from Yahoo Finance.
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
        stock_price_currency: priceData.currency || 'CAD',
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
      console.error(`[ERROR] Yahoo Finance attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
      if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt), `Retrying Yahoo Finance for ${ticker}`);
    }
  }
  console.error(`[ERROR] Exhausted retries for Yahoo Finance fetch for ${ticker}`);
  return null;
}

/**
 * Scrapes financial data from TradingView.
 */
async function fetchTradingViewData(ticker) {
  const exchange = getExchangeFromTicker(ticker);
  const symbol = ticker.split('.')[0];
  const url = `https://www.tradingview.com/symbols/${exchange}-${symbol}/financials-overview/`;
  console.log(`[INFO] Scraping TradingView data for ${ticker} from ${url}`);

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const data = await page.evaluate(() => {
      const priceSelectors = [
        '.tv-symbol-price-quote__value',
        '.js-symbol-last',
        '.priceWrapper-ujadn3P8 span'
      ];
      const marketCapSelectors = [
        '[data-field-key="market_cap"]',
        '.marketCapValue-ujadn3P8'
      ];

      let stockPrice = null;
      for (const selector of priceSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          stockPrice = parseFloat(element.textContent.trim().replace(/[^0-9.]/g, ''));
          break;
        }
      }

      let marketCap = null;
      for (const selector of marketCapSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          marketCap = parseFloat(element.textContent.trim().replace(/[^0-9.]/g, ''));
          break;
        }
      }

      return {
        stock_price: stockPrice,
        stock_price_currency: 'CAD',
        market_cap_value: marketCap,
        market_cap_currency: 'CAD'
      };
    });

    if (!data.stock_price) {
      console.error(`[ERROR] Could not scrape stock price for ${ticker}`);
      return null;
    }
    console.log(`[INFO] Successfully scraped TradingView data for ${ticker}:`, JSON.stringify(data));
    return data;
  } catch (e) {
    console.error(`[ERROR] Failed to fetch TradingView data for ${ticker}: ${e.message}`);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Fetches financial data from Alpha Vantage.
 */
async function fetchAlphaVantageData(ticker) {
  const baseUrl = 'https://www.alphavantage.co/query';
  const data = {};

  try {
    const quoteResponse = await axios.get(`${baseUrl}?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`);
    const quoteData = quoteResponse.data['Global Quote'];
    if (quoteData && quoteData['05. price']) {
      data.stock_price = parseFloat(quoteData['05. price']);
      data.stock_price_currency = 'CAD';
      console.log(`[INFO] Fetched Alpha Vantage stock price for ${ticker}: ${data.stock_price}`);
    }
  } catch (e) {
    console.warn(`[WARN] Failed to fetch Alpha Vantage stock price for ${ticker}: ${e.message}`);
  }

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
 * Cross-verifies data from multiple sources.
 */
function crossVerifyData(yahooData, tradingViewData, alphaData) {
  const verified = {};

  const logDiscrepancy = (field, value1, value2, source1, source2, threshold = CAD_THRESHOLD) => {
    if (value1 && value2 && Math.abs(value1 - value2) / Math.max(value1, value2) > threshold) {
      console.warn(`[WARN] Discrepancy in ${field}: ${source1}=${value1}, ${source2}=${value2}`);
    }
  };

  verified.stock_price = yahooData?.stock_price ?? tradingViewData?.stock_price ?? alphaData?.stock_price ?? 0;
  verified.stock_price_currency = yahooData?.stock_price_currency ?? tradingViewData?.stock_price_currency ?? alphaData?.stock_price_currency ?? 'CAD';
  logDiscrepancy('stock_price', yahooData?.stock_price, tradingViewData?.stock_price, 'Yahoo', 'TradingView');

  verified.number_of_shares = yahooData?.number_of_shares ?? 0;

  verified.market_cap_value = yahooData?.market_cap_value ?? tradingViewData?.market_cap_value ?? (verified.stock_price * verified.number_of_shares) ?? 0;
  verified.market_cap_currency = yahooData?.market_cap_currency ?? tradingViewData?.market_cap_currency ?? verified.stock_price_currency;

  verified.cash_value = yahooData?.cash_value ?? alphaData?.cash_value ?? 0;
  verified.cash_currency = yahooData?.cash_currency ?? alphaData?.cash_currency ?? 'USD';

  verified.debt_value = yahooData?.debt_value ?? alphaData?.debt_value ?? 0;
  verified.debt_currency = yahooData?.debt_currency ?? alphaData?.debt_currency ?? 'USD';

  verified.enterprise_value_value = yahooData?.enterprise_value_value ?? 
    (verified.market_cap_value + verified.debt_value - verified.cash_value) ?? 0;
  verified.enterprise_value_currency = yahooData?.enterprise_value_currency ?? verified.market_cap_currency;

  verified.revenue_value = yahooData?.revenue_value ?? alphaData?.revenue_value ?? 0;
  verified.revenue_currency = yahooData?.revenue_currency ?? alphaData?.revenue_currency ?? 'USD';

  verified.net_income_value = yahooData?.net_income_value ?? alphaData?.net_income_value ?? 0;
  verified.net_income_currency = yahooData?.net_income_currency ?? alphaData?.net_income_currency ?? 'USD';

  console.log(`[INFO] Verified data for cross-verification:`, JSON.stringify(verified));
  return verified;
}

/**
 * Updates the database with verified data.
 */
async function updateDatabase(ticker, data) {
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
    new Date().toISOString(),
    await convertToCAD(data.market_cap_value, data.market_cap_currency),
    await convertToCAD(data.cash_value, data.cash_currency),
    await convertToCAD(data.debt_value, data.debt_currency),
    await convertToCAD(data.enterprise_value_value, data.enterprise_value_currency),
    await convertToCAD(data.revenue_value, data.revenue_currency),
    await convertToCAD(data.net_income_value, data.net_income_currency),
    ticker
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
    db.run(sql, values, async function(err) {
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
 * Main function to process companies.
 */
async function main() {
  try {
    const csvData = await fs.readFile(CSV_FILE, 'utf8');
    const cleanedCsvData = csvData.trim().replace(/^\ufeff/, '');
    const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });

    console.log(`[INFO] Parsed ${companies.length} companies from CSV: ${companies.map(c => c.TICKER).join(', ')}`);

    for (const company of companies) {
      const ticker = company.TICKER;
      if (!ticker) {
        console.warn(`[WARN] Skipping entry with missing ticker: ${JSON.stringify(company)}`);
        continue;
      }

      console.log(`\n=== Processing ${ticker} ===`);

      const yahooData = await fetchYahooData(ticker);
      await delay(DELAY_BETWEEN_CALLS, `Pausing after Yahoo fetch for ${ticker}`);

      let tradingViewData = null;
      if (USE_TRADINGVIEW) {
        tradingViewData = await fetchTradingViewData(ticker);
        await delay(DELAY_BETWEEN_CALLS, `Pausing after TradingView fetch for ${ticker}`);
      } else {
        console.log(`[INFO] TradingView disabled for ${ticker}`);
      }

      let alphaData = {};
      if (USE_ALPHA_VANTAGE) {
        alphaData = await fetchAlphaVantageData(ticker);
        await delay(DELAY_BETWEEN_CALLS, `Pausing after Alpha Vantage fetch for ${ticker}`);
      } else {
        console.log(`[INFO] Alpha Vantage disabled for ${ticker}`);
      }

      const verifiedData = crossVerifyData(yahooData, tradingViewData, alphaData);
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

main();