const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const yahooFinance = require('yahoo-finance2').default;
const { parse } = require('csv-parse/sync');
const fs = require('fs').promises;
const path = require('path');
const similarity = require('string-similarity');

puppeteer.use(StealthPlugin());
yahooFinance.suppressNotices(['yahooSurvey']);

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';
const LOG_FILE = 'verification_log.txt';
const CAD_THRESHOLD = 0.02;

function normalizeName(name) {
  if (!name) return '';
  const suffixes = ['inc', 'corp', 'corporation', 'ltd', 'limited', 'co', 'company', 'incorporated'];
  const regex = new RegExp(`\\s+(${suffixes.join('|')})\\.?$`, 'i');
  return name.replace(regex, '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
}

function urlFriendlyName(name) {
  return normalizeName(name).replace(/\s+/g, '-');
}

async function fetchWithRetry(page, url, retries = 3, delay = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      const status = response.status();
      if (status !== 200) throw new Error(`HTTP status ${status}`);
      return status;
    } catch (e) {
      console.warn(`Attempt ${i + 1} failed for ${url}: ${e}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`Failed to load ${url} after ${retries} attempts`);
}

async function fetchJuniorMining(ticker, name, nameAlt) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const urls = [
    'https://www.juniorminingnetwork.com/mining-stocks/gold-mining-stocks.html',
    'https://www.juniorminingnetwork.com/mining-stocks/silver-mining-stocks.html'
  ];
  let bestData = { price: 0, marketCap: 0 };

  for (const url of urls) {
    try {
      const status = await fetchWithRetry(page, url);
      console.log(`Junior Mining accessed ${url} for ${ticker}: HTTP ${status}`);
      const data = await page.evaluate((t, n, na) => {
        const rows = Array.from(document.querySelectorAll('.stock-table tbody tr'));
        const row = rows.find(r => {
          const ticker = r.querySelector('.ticker')?.textContent.trim();
          const rowName = r.querySelector('.company')?.textContent.trim() || '';
          const normalizedRowName = rowName ? rowName.replace(/\s+(inc|corp|ltd|limited|co|company|incorporated)\.?$/i, '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '') : '';
          return ticker === t || normalizedRowName === n || (na && normalizedRowName === na);
        });
        return row ? {
          price: parseFloat(row.querySelector('.last-trade')?.textContent.replace(/[^0-9.]/g, '') || '0'),
          marketCap: parseFloat(row.querySelector('.market-cap')?.textContent.replace(/[^0-9.]/g, '') || '0') * 
                    (row.textContent.includes('B') ? 1e9 : row.textContent.includes('M') ? 1e6 : 1)
        } : null;
      }, ticker, normalizeName(name), nameAlt ? normalizeName(nameAlt) : '');
      if (data && (data.price > 0 || data.marketCap > 0)) {
        console.log(`Junior Mining found data for ${ticker} on ${url.split('/').pop()}: Price=${data.price}, MarketCap=${data.marketCap}`);
        bestData = data;
        break;
      }
    } catch (e) {
      console.error(`Junior Mining fetch failed for ${ticker} on ${url}: ${e}`);
    }
  }
  await browser.close();
  return { price: bestData.price, marketCap: bestData.marketCap, currency: 'CAD' };
}

async function fetchYahooFinance(ticker, name, nameAlt) {
  try {
    const quote = await yahooFinance.quote(ticker);
    const normalizedFetchedName = normalizeName(quote.shortName || '');
    const normalizedName = normalizeName(name);
    const normalizedNameAlt = nameAlt ? normalizeName(nameAlt) : '';
    const match = similarity.compareTwoStrings(normalizedFetchedName, normalizedName) > 0.7 ||
                  (nameAlt && similarity.compareTwoStrings(normalizedFetchedName, normalizedNameAlt) > 0.7);
    if (!match) {
      console.warn(`Yahoo name mismatch for ${ticker}: expected "${name}" or "${nameAlt}", got "${quote.shortName}"`);
      if (quote.symbol === ticker) {
        console.log(`Using Yahoo data for ${ticker} despite name mismatch`);
      } else {
        throw new Error('Ticker mismatch');
      }
    }
    return {
      price: quote.regularMarketPrice || 0,
      marketCap: quote.marketCap || 0,
      shares: quote.sharesOutstanding || 0,
      currency: quote.currency === 'CAD' ? 'CAD' : 'CAD'
    };
  } catch (e) {
    console.error(`Yahoo fetch failed for ${ticker}: ${e}`);
    return { price: 0, marketCap: 0, shares: 0, currency: 'CAD' };
  }
}

async function fetchMiningFeeds(ticker, name, nameAlt) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const exchange = ticker.endsWith('.TO') ? 'tsx' : ticker.endsWith('.V') ? 'tsxv' : 'cse';
  const urlName = urlFriendlyName(name);
  try {
    const status = await fetchWithRetry(page, `https://www.miningfeeds.com/stock/${urlName}-${exchange}/`);
    console.log(`MiningFeeds accessed for ${ticker}: HTTP ${status}`);
    await page.waitForSelector('.stock-data', { timeout: 30000 }); // Updated selector
    const companyName = await page.evaluate(() => {
      const nameEl = document.querySelector('.company-breadcrumbs .active a') || document.querySelector('h1');
      return nameEl ? nameEl.textContent.trim() : '';
    });
    const normalizedFetchedName = normalizeName(companyName);
    const normalizedName = normalizeName(name);
    const normalizedNameAlt = nameAlt ? normalizeName(nameAlt) : '';
    const match = similarity.compareTwoStrings(normalizedFetchedName, normalizedName) > 0.7 ||
                  (nameAlt && similarity.compareTwoStrings(normalizedFetchedName, normalizedNameAlt) > 0.7);
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
      const price = priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '') || '0') : 0;
      const marketCapText = marketCapEl ? marketCapEl.textContent.replace(/[^0-9.BM]/g, '') : '0';
      const marketCapMultiplier = marketCapText.includes('B') ? 1e9 : marketCapText.includes('M') ? 1e6 : 1;
      const marketCap = marketCapText ? parseFloat(marketCapText.replace(/[BM]/i, '')) * marketCapMultiplier : 0;
      return { price, marketCap };
    });
    console.log(`MiningFeeds fetched for ${ticker}: Price=${data.price}, MarketCap=${data.marketCap}`);
    await browser.close();
    return { price: data.price, marketCap: data.marketCap, currency: 'CAD' };
  } catch (e) {
    console.error(`MiningFeeds fetch failed for ${ticker}: ${e}`);
    const content = await page.content();
    console.log(`Dumping MiningFeeds page content for ${ticker}:`, content.slice(0, 500));
    await browser.close();
    return { price: 0, marketCap: 0, currency: 'CAD' };
  }
}

async function fetchTradingView(ticker, name, nameAlt) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const exchange = ticker.endsWith('.TO') ? 'TSX' : ticker.endsWith('.V') ? 'TSXV' : 'CSE';
  const cleanTicker = ticker.replace('.', '-');
  try {
    const status = await fetchWithRetry(page, `https://www.tradingview.com/symbols/${exchange}-${cleanTicker}/`);
    console.log(`TradingView accessed for ${ticker}: HTTP ${status}`);
    await page.waitForSelector('.tv-symbol-header__title', { timeout: 30000 }); // Updated selector
    const companyName = await page.evaluate(() => document.querySelector('.tv-symbol-header__title')?.textContent.trim() || '');
    const normalizedFetchedName = normalizeName(companyName);
    const normalizedName = normalizeName(name);
    const normalizedNameAlt = nameAlt ? normalizeName(nameAlt) : '';
    const match = similarity.compareTwoStrings(normalizedFetchedName, normalizedName) > 0.7 ||
                  (nameAlt && similarity.compareTwoStrings(normalizedFetchedName, normalizedNameAlt) > 0.7);
    if (!match && companyName) {
      console.warn(`TradingView name mismatch for ${ticker}: expected "${name}" or "${nameAlt}", got "${companyName}"`);
      if (page.url().includes(cleanTicker.toUpperCase()) || page.url().includes(ticker.split('.')[0].toUpperCase())) {
        console.log(`Using TradingView data for ${ticker} despite name mismatch`);
      } else {
        throw new Error('URL mismatch');
      }
    }
    const data = await page.evaluate(() => {
      const priceEl = document.querySelector('.tv-symbol-price-quote__value');
      const marketCapEl = document.querySelector('.js-symbol-market-cap');
      return {
        price: priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g, '') || '0') : 0,
        marketCap: marketCapEl ? parseFloat(marketCapEl.textContent.replace(/[^0-9.BM]/g, '') || '0') * 
                  (marketCapEl.textContent.includes('B') ? 1e9 : marketCapEl.textContent.includes('M') ? 1e6 : 1) : 0
      };
    });
    console.log(`TradingView fetched for ${ticker}: Price=${data.price}, MarketCap=${data.marketCap}`);
    await browser.close();
    return { price: data.price, marketCap: data.marketCap, currency: 'CAD' };
  } catch (e) {
    console.error(`TradingView fetch failed for ${ticker}: ${e}`);
    const content = await page.content();
    console.log(`Dumping TradingView page content for ${ticker}:`, content.slice(0, 500));
    await browser.close();
    return { price: 0, marketCap: 0, currency: 'CAD' };
  }
}

async function resolveData(ticker, jmn, yahoo, mf, tv) {
  const log = [`[${ticker}] - ${new Date().toISOString().split('T')[0]}`];
  const sources = { jmn, yahoo, mf, tv };
  const validPrices = Object.entries(sources)
    .filter(([_, source]) => source.price > 0)
    .map(([sourceName, source]) => ({ name: sourceName, value: source.price }));
  const priceVariance = validPrices.length > 1 ? Math.max(...validPrices.map(p => Math.abs(p.value - (jmn.price || yahoo.price)) / (jmn.price || yahoo.price))) : 0;
  let finalPrice = validPrices.length ? validPrices.reduce((sum, p) => sum + p.value, 0) / validPrices.length : yahoo.price || 0;
  if (validPrices.length === 0) {
    console.warn(`No valid price data for ${ticker}, falling back to Yahoo or 0`);
  } else if (priceVariance > CAD_THRESHOLD) {
    console.log(`High price variance for ${ticker}: ${validPrices.map(p => `${p.name}=${p.value}`).join(', ')}`);
  }
  log.push(`Stock Price: JMN=${jmn.price || 'N/A'} CAD, Yahoo=${yahoo.price || 'N/A'} CAD, MF=${mf.price || 'N/A'} CAD, TV=${tv.price || 'N/A'} CAD, Variance=${priceVariance.toFixed(2)}%, Resolved=${finalPrice} CAD`);

  const validCaps = Object.entries(sources)
    .filter(([_, source]) => source.marketCap > 0)
    .map(([sourceName, source]) => ({ name: sourceName, value: source.marketCap }));
  const capVariance = validCaps.length > 1 ? Math.max(...validCaps.map(c => Math.abs(c.value - (jmn.marketCap || yahoo.marketCap)) / (jmn.marketCap || yahoo.marketCap))) : 0;
  let finalMarketCap = validCaps.length ? validCaps.reduce((sum, c) => sum + c.value, 0) / validCaps.length : yahoo.marketCap || 0;
  if (validCaps.length === 0) {
    console.warn(`No valid market cap data for ${ticker}, falling back to Yahoo or 0`);
  } else if (capVariance > CAD_THRESHOLD) {
    console.log(`High market cap variance for ${ticker}: ${validCaps.map(c => `${c.name}=${c.value}`).join(', ')}`);
  }
  log.push(`Market Cap: JMN=${jmn.marketCap || 'N/A'} CAD, Yahoo=${yahoo.marketCap || 'N/A'} CAD, MF=${mf.marketCap || 'N/A'} CAD, TV=${tv.marketCap || 'N/A'} CAD, Variance=${capVariance.toFixed(2)}%, Resolved=${finalMarketCap} CAD`);

  await fs.appendFile(LOG_FILE, log.join('\n') + '\n');
  return { price: finalPrice, marketCap: finalMarketCap, shares: yahoo.shares || 0 };
}

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

async function main() {
  const csvData = await fs.readFile(CSV_FILE, 'utf8');
  const cleanedCsvData = csvData.replace(/^\ufeff/, '');
  const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });

  for (const { TICKER: ticker, NAME: name, NAMEALT: nameAlt } of companies) {
    console.log(`Processing ${ticker}`);
    const [jmn, yahoo, mf, tv] = await Promise.all([
      fetchJuniorMining(ticker, name, nameAlt),
      fetchYahooFinance(ticker, name, nameAlt),
      fetchMiningFeeds(ticker, name, nameAlt),
      fetchTradingView(ticker, name, nameAlt)
    ]);
    const resolved = await resolveData(ticker, jmn, yahoo, mf, tv);
    await updateJsonFile(ticker, resolved, name);
    console.log(`Updated ${ticker}: Price=${resolved.price} CAD, Market Cap=${resolved.marketCap} CAD, Shares=${resolved.shares}`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

main().catch(error => {
  console.error('Main process failed:', error);
});