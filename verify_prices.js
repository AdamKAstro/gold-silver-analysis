const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const yahooFinance = require('yahoo-finance2').default;
const { parse } = require('csv-parse/sync');
const fs = require('fs').promises;
const path = require('path');
const similarity = require('string-similarity');

puppeteer.use(StealthPlugin());
yahooFinance.suppressNotices(['yahooSurvey']);

// Configuration
const USE_ALL_SOURCES = false; // Toggle: true = all 4 sources, false = Yahoo + TradingView only
const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';
const LOG_FILE = 'verification_log.txt';
const CAD_THRESHOLD = 0.02; // Variance threshold
const MAX_RETRIES = 2; // Max retries per source
const DELAY_BETWEEN_REQUESTS = 3000; // 3 seconds between ticker requests
const TIMEOUT_FAST = 10000; // 10 seconds for fast mode
const TIMEOUT_FULL = 30000; // 30 seconds for full mode

// Helper function for delays
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Normalize company names for matching
function normalizeName(name) {
  if (!name) return '';
  const suffixes = ['inc', 'corp', 'corporation', 'ltd', 'limited', 'co', 'company', 'incorporated'];
  const regex = new RegExp(`\\s+(${suffixes.join('|')})\\.?$`, 'i');
  return name.replace(regex, '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
}

// Convert name to URL-friendly format
function urlFriendlyName(name) {
  return normalizeName(name).replace(/\s+/g, '-');
}

// Fetch with retry logic
async function fetchWithRetry(page, url, retries = MAX_RETRIES, delayMs = DELAY_BETWEEN_REQUESTS, timeout = TIMEOUT_FULL) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout });
      const status = response.status();
      console.log(`Accessed ${url} for fetch: HTTP ${status}`);
      if (status !== 200) throw new Error(`HTTP status ${status}`);
      return status;
    } catch (e) {
      console.warn(`Attempt ${i + 1} failed for ${url}: ${e.message}`);
      if (i < retries - 1) await delay(delayMs);
    }
  }
  throw new Error(`Failed to load ${url} after ${retries} attempts`);
}

// Fetch from Junior Mining Network (group pages)
async function fetchJuniorMining(ticker, name, nameAlt) {
  if (!USE_ALL_SOURCES) return { price: null, marketCap: null }; // Skip in fast mode
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const urls = [
    'https://www.juniorminingnetwork.com/mining-stocks/gold-mining-stocks.html',
    'https://www.juniorminingnetwork.com/mining-stocks/silver-mining-stocks.html'
  ];
  let bestData = { price: null, marketCap: null };

  for (const url of urls) {
    try {
      const status = await fetchWithRetry(page, url);
      await page.waitForFunction(() => {
        const rows = Array.from(document.querySelectorAll('.stock-table tbody tr'));
        return rows.length > 0;
      }, { timeout: TIMEOUT_FULL });
      const data = await page.evaluate((t, n, na) => {
        const rows = Array.from(document.querySelectorAll('.stock-table tbody tr'));
        const row = rows.find(r => {
          const ticker = r.querySelector('.ticker')?.textContent.trim();
          const rowName = r.querySelector('.company')?.textContent.trim() || '';
          const normalizedRowName = rowName.toLowerCase().replace(/\s+(inc|corp|ltd|limited|co|company|incorporated)\.?$/i, '').replace(/[^a-z0-9 ]/g, '');
          return ticker === t || normalizedRowName === n || (na && normalizedRowName === na);
        });
        if (row) {
          const price = parseFloat(row.querySelector('.last-trade')?.textContent.replace(/[^0-9.]/g, '') || '0');
          const marketCapText = row.querySelector('.market-cap')?.textContent.replace(/[^0-9.BM]/g, '') || '0';
          const marketCapMultiplier = marketCapText.includes('B') ? 1e9 : marketCapText.includes('M') ? 1e6 : 1;
          const marketCap = parseFloat(marketCapText.replace(/[BM]/i, '')) * marketCapMultiplier;
          const rowName = row.querySelector('.company')?.textContent.trim() || '';
          return { price: price || null, marketCap: marketCap || null, rowName };
        }
        return null;
      }, ticker, normalizeName(name), nameAlt ? normalizeName(nameAlt) : '');

      if (data && (data.price || data.marketCap)) {
        const normalizedFetchedName = normalizeName(data.rowName);
        const match = similarity.compareTwoStrings(normalizedFetchedName, normalizeName(name)) > 0.7 ||
                      (nameAlt && similarity.compareTwoStrings(normalizedFetchedName, normalizeName(nameAlt)) > 0.7);
        if (!match) {
          console.warn(`JMN name mismatch for ${ticker}: expected "${name}" or "${nameAlt}", got "${data.rowName}"`);
        }
        console.log(`JMN found data for ${ticker} on ${url.split('/').pop()}: Price=${data.price}, MarketCap=${data.marketCap}`);
        bestData = { price: data.price, marketCap: data.marketCap };
        break;
      }
    } catch (e) {
      console.error(`JMN fetch failed for ${ticker} on ${url}: ${e.message}`);
      const content = await page.content();
      console.log(`Dumping JMN page content for ${ticker}:`, content.slice(0, 500));
    }
  }
  await browser.close();
  return bestData;
}

// Fetch from Yahoo Finance
async function fetchYahooFinance(ticker, name, nameAlt) {
  try {
    const quote = await yahooFinance.quote(ticker);
    const normalizedFetchedName = normalizeName(quote.shortName || '');
    const match = similarity.compareTwoStrings(normalizedFetchedName, normalizeName(name)) > 0.7 ||
                  (nameAlt && similarity.compareTwoStrings(normalizedFetchedName, normalizeName(nameAlt)) > 0.7);
    if (!match) {
      console.warn(`Yahoo name mismatch for ${ticker}: expected "${name}" or "${nameAlt}", got "${quote.shortName}"`);
      if (quote.symbol === ticker) {
        console.log(`Using Yahoo data for ${ticker} despite name mismatch`);
      } else {
        throw new Error('Ticker mismatch');
      }
    }
    return {
      price: quote.regularMarketPrice || null,
      marketCap: quote.marketCap || null,
      shares: quote.sharesOutstanding || 0,
      currency: quote.currency === 'CAD' ? 'CAD' : 'CAD'
    };
  } catch (e) {
    console.error(`Yahoo fetch failed for ${ticker}: ${e.message}`);
    return { price: null, marketCap: null, shares: 0, currency: 'CAD' };
  }
}

// Fetch from MiningFeeds (stock page)
async function fetchMiningFeeds(ticker, name, nameAlt) {
  if (!USE_ALL_SOURCES) return { price: null, marketCap: null }; // Skip in fast mode
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const exchange = ticker.endsWith('.TO') ? 'tsx' : ticker.endsWith('.V') ? 'tsxv' : 'cse';
  const urlName = urlFriendlyName(name);
  const url = `https://www.miningfeeds.com/stock/${urlName}-${exchange}/`;
  try {
    const status = await fetchWithRetry(page, url);
    await page.waitForSelector('.stock-data', { timeout: TIMEOUT_FULL });
    const companyName = await page.evaluate(() => {
      const nameEl = document.querySelector('.company-breadcrumbs .active a') || document.querySelector('h1');
      return nameEl ? nameEl.textContent.trim() : '';
    });
    const normalizedFetchedName = normalizeName(companyName);
    const match = similarity.compareTwoStrings(normalizedFetchedName, normalizeName(name)) > 0.7 ||
                  (nameAlt && similarity.compareTwoStrings(normalizedFetchedName, normalizeName(nameAlt)) > 0.7);
    if (!match && companyName) {
      console.warn(`MiningFeeds name mismatch for ${ticker}: expected "${name}" or "${nameAlt}", got "${companyName}"`);
      if (page.url().includes(urlName.toLowerCase())) {
        console.log(`Using MiningFeeds data for ${ticker} despite name mismatch`);
      } else {
        throw new Error('URL mismatch');
      }
    }
    const data = await page.evaluate(() => {
      const priceEl = document.querySelector('.stock-data .price');
      const marketCapEl = document.querySelector('.stock-data .market-cap');
      const price = priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '') || '0') : null;
      const marketCapText = marketCapEl ? marketCapEl.textContent.replace(/[^0-9.BM]/g, '') : '0';
      const marketCapMultiplier = marketCapText.includes('B') ? 1e9 : marketCapText.includes('M') ? 1e6 : 1;
      const marketCap = marketCapText ? parseFloat(marketCapText.replace(/[BM]/i, '')) * marketCapMultiplier : null;
      return { price, marketCap };
    });
    console.log(`MiningFeeds fetched for ${ticker}: Price=${data.price}, MarketCap=${data.marketCap}`);
    await browser.close();
    return { price: data.price, marketCap: data.marketCap };
  } catch (e) {
    console.error(`MiningFeeds fetch failed for ${ticker}: ${e.message}`);
    const content = await page.content();
    console.log(`Dumping MiningFeeds page content for ${ticker}:`, content.slice(0, 500));
    await browser.close();
    return { price: null, marketCap: null };
  }
}

// Fetch from TradingView
async function fetchTradingView(ticker, name, nameAlt) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const exchange = ticker.endsWith('.TO') ? 'TSX' : ticker.endsWith('.V') ? 'TSXV' : 'CSE';
  const cleanTicker = ticker.replace('.', '-');
  const url = `https://www.tradingview.com/symbols/${exchange}-${cleanTicker}/`;
  const timeout = USE_ALL_SOURCES ? TIMEOUT_FULL : TIMEOUT_FAST;

  try {
    const status = await fetchWithRetry(page, url, undefined, undefined, timeout);
    await page.waitForFunction(() => {
      const priceEl = document.querySelector('.js-symbol-last');
      return priceEl && priceEl.textContent.trim() !== '';
    }, { timeout });
    const companyName = await page.evaluate(() => document.querySelector('.tv-symbol-header__title')?.textContent.trim() || '');
    const normalizedFetchedName = normalizeName(companyName);
    const match = similarity.compareTwoStrings(normalizedFetchedName, normalizeName(name)) > 0.7 ||
                  (nameAlt && similarity.compareTwoStrings(normalizedFetchedName, normalizeName(nameAlt)) > 0.7);
    if (!match && companyName) {
      console.warn(`TradingView name mismatch for ${ticker}: expected "${name}" or "${nameAlt}", got "${companyName}"`);
      if (page.url().includes(cleanTicker.toUpperCase()) || page.url().includes(ticker.split('.')[0].toUpperCase())) {
        console.log(`Using TradingView data for ${ticker} despite name mismatch`);
      } else {
        throw new Error('URL mismatch');
      }
    }
    const data = await page.evaluate(() => {
      const priceEl = document.querySelector('.js-symbol-last');
      const marketCapEl = document.querySelector('.js-symbol-market-cap');
      const price = priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '') || '0') : null;
      const marketCapText = marketCapEl ? marketCapEl.textContent.replace(/[^0-9.BM]/g, '') : '0';
      const marketCapMultiplier = marketCapText.includes('B') ? 1e9 : marketCapText.includes('M') ? 1e6 : 1;
      const marketCap = marketCapText ? parseFloat(marketCapText.replace(/[BM]/i, '')) * marketCapMultiplier : null;
      return { price, marketCap };
    });
    console.log(`TradingView fetched for ${ticker}: Price=${data.price}, MarketCap=${data.marketCap}`);
    await browser.close();
    return { price: data.price, marketCap: data.marketCap };
  } catch (e) {
    console.error(`TradingView fetch failed for ${ticker}: ${e.message}`);
    const content = await page.content();
    console.log(`Dumping TradingView page content for ${ticker}:`, content.slice(0, 500));
    await browser.close();
    return { price: null, marketCap: null };
  }
}

// Resolve data from all sources
async function resolveData(ticker, jmn, yahoo, mf, tv) {
  const log = [`[${ticker}] - ${new Date().toISOString()}`];
  const sources = { jmn, yahoo, mf, tv };

  // Resolve prices
  const validPrices = Object.entries(sources)
    .filter(([_, source]) => source.price !== null && source.price > 0)
    .map(([sourceName, source]) => ({ name: sourceName, value: source.price }));
  const priceVariance = validPrices.length > 1
    ? Math.max(...validPrices.map(p => Math.max(...validPrices.map(p2 => Math.abs(p.value - p2.value)))))
    : 0;
  let finalPrice;
  if (validPrices.length === 0) {
    console.warn(`No valid price data for ${ticker}, using 0`);
    finalPrice = 0;
  } else if (priceVariance > CAD_THRESHOLD) {
    console.warn(`High price variance for ${ticker}: ${validPrices.map(p => `${p.name}=${p.value}`).join(', ')}`);
    finalPrice = yahoo.price || (validPrices.reduce((sum, p) => sum + p.value, 0) / validPrices.length);
  } else {
    finalPrice = validPrices.reduce((sum, p) => sum + p.value, 0) / validPrices.length;
  }
  log.push(`Stock Price: JMN=${jmn.price || 'N/A'} CAD, Yahoo=${yahoo.price || 'N/A'} CAD, MF=${mf.price || 'N/A'} CAD, TV=${tv.price || 'N/A'} CAD, Variance=${priceVariance.toFixed(2)}, Resolved=${finalPrice.toFixed(3)} CAD`);

  // Resolve market caps
  const validCaps = Object.entries(sources)
    .filter(([_, source]) => source.marketCap !== null && source.marketCap > 0)
    .map(([sourceName, source]) => ({ name: sourceName, value: source.marketCap }));
  const capVariance = validCaps.length > 1
    ? Math.max(...validCaps.map(c => Math.max(...validCaps.map(c2 => Math.abs(c.value - c2.value)))))
    : 0;
  let finalMarketCap;
  if (validCaps.length === 0) {
    console.warn(`No valid market cap data for ${ticker}, using 0`);
    finalMarketCap = 0;
  } else if (capVariance > CAD_THRESHOLD) {
    console.warn(`High market cap variance for ${ticker}: ${validCaps.map(c => `${c.name}=${c.value}`).join(', ')}`);
    finalMarketCap = yahoo.marketCap || (validCaps.reduce((sum, c) => sum + c.value, 0) / validCaps.length);
  } else {
    finalMarketCap = validCaps.reduce((sum, c) => sum + c.value, 0) / validCaps.length;
  }
  log.push(`Market Cap: JMN=${jmn.marketCap || 'N/A'} CAD, Yahoo=${yahoo.marketCap || 'N/A'} CAD, MF=${mf.marketCap || 'N/A'} CAD, TV=${tv.marketCap || 'N/A'} CAD, Variance=${capVariance.toFixed(2)}, Resolved=${finalMarketCap.toFixed(0)} CAD`);

  await fs.appendFile(LOG_FILE, log.join('\n') + '\n');
  return { price: finalPrice, marketCap: finalMarketCap, shares: yahoo.shares || 0 };
}

// Update JSON file
async function updateJsonFile(ticker, data, name) {
  const filePath = path.join(DATA_DIR, `${ticker}.json`);
  let jsonData;
  try {
    jsonData = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (e) {
    jsonData = {
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
      news_link: `https://www.miningfeeds.com/stock/${urlFriendlyName(name)}-${ticker.endsWith('.TO') ? 'tsx' : ticker.endsWith('.V') ? 'tsxv' : 'cse'}/`
    };
  }
  jsonData.stock_price = data.price;
  jsonData.market_cap_value = data.marketCap;
  jsonData.number_of_shares = data.shares;
  jsonData.stock_price_currency = 'CAD';
  jsonData.market_cap_currency = 'CAD';
  jsonData.last_updated = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
}

// Main function
async function main() {
  const csvData = await fs.readFile(CSV_FILE, 'utf8');
  const cleanedCsvData = csvData.replace(/^\ufeff/, '');
  const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });

  for (const { TICKER: ticker, NAME: name, NAMEALT: nameAlt } of companies) {
    console.log(`Processing ${ticker}`);
    let jmn = { price: null, marketCap: null };
    let yahoo = { price: null, marketCap: null, shares: 0 };
    let mf = { price: null, marketCap: null };
    let tv = { price: null, marketCap: null };

    // Fetch all sources with retries
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const fetches = [
          fetchYahooFinance(ticker, name, nameAlt).then(result => yahoo = result),
          fetchTradingView(ticker, name, nameAlt).then(result => tv = result)
        ];
        if (USE_ALL_SOURCES) {
          fetches.push(fetchJuniorMining(ticker, name, nameAlt).then(result => jmn = result));
          fetches.push(fetchMiningFeeds(ticker, name, nameAlt).then(result => mf = result));
        }
        await Promise.all(fetches);
        break;
      } catch (e) {
        console.error(`Attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
        if (attempt < MAX_RETRIES) await delay(DELAY_BETWEEN_REQUESTS);
        else {
          console.warn(`All retries exhausted for ${ticker}, using partial data`);
        }
      }
    }

    const resolved = await resolveData(ticker, jmn, yahoo, mf, tv);
    await updateJsonFile(ticker, resolved, name);
    console.log(`Updated ${ticker}: Price=${resolved.price.toFixed(3)} CAD, Market Cap=${resolved.marketCap.toFixed(0)} CAD, Shares=${resolved.shares}`);
    await delay(DELAY_BETWEEN_REQUESTS);
  }
}

main().catch(error => console.error('Main process failed:', error));