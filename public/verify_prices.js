const puppeteer = require('puppeteer');
const yahooFinance = require('yahoo-finance2').default;
const { parse } = require('csv-parse/sync');
const fs = require('fs').promises;
const path = require('path');
const similarity = require('string-similarity');

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';
const LOG_FILE = 'verification_log.txt';
const CAD_THRESHOLD = 0.02;
const GOLD_SILVER_RATIO = 80; // Adjustable Ag:Au ratio

async function fetchJuniorMining(ticker, name, nameAlt) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto('https://www.juniorminingnetwork.com/mining-stocks/gold-mining-stocks.html', { waitUntil: 'networkidle2' });
    const data = await page.evaluate((t, n, na) => {
      const rows = Array.from(document.querySelectorAll('tr'));
      const row = rows.find(r => {
        const ticker = r.querySelector('.ticker')?.textContent.trim();
        const rowName = r.querySelector('.name')?.textContent.trim();
        return ticker === t || rowName === n || (na && rowName === na);
      });
      return row ? {
        price: parseFloat(row.querySelector('.last-trade')?.textContent.replace(/[^0-9.]/g, '')),
        marketCap: parseFloat(row.querySelector('.market-cap')?.textContent.replace(/[^0-9.]/g, '')) * (row.textContent.includes('B') ? 1e9 : 1e6)
      } : {};
    }, ticker, name, nameAlt);
    await browser.close();
    return { price: data.price || null, marketCap: data.marketCap || null, currency: 'CAD' };
  } catch (e) {
    console.error(`Junior Mining fetch failed for ${ticker}: ${e}`);
    await browser.close();
    return { price: null, marketCap: null, currency: 'CAD' };
  }
}

async function fetchYahooFinance(ticker, name, nameAlt) {
  try {
    const quote = await yahooFinance.quote(ticker);
    const match = quote.shortName && (similarity.compareTwoStrings(quote.shortName, name) > 0.8 || (nameAlt && similarity.compareTwoStrings(quote.shortName, nameAlt) > 0.8));
    if (!match) throw new Error('Name mismatch');
    return { price: quote.regularMarketPrice, marketCap: quote.marketCap, currency: quote.currency };
  } catch (e) {
    console.error(`Yahoo fetch failed for ${ticker}: ${e}`);
    return { price: null, marketCap: null, currency: 'CAD' };
  }
}

async function fetchMiningFeeds(ticker, name, nameAlt) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const baseTicker = ticker.replace('.TO', '').replace('.V', '').replace('.CN', '');
  try {
    await page.goto(`https://www.miningfeeds.com/company/${baseTicker.toLowerCase()}/`, { waitUntil: 'networkidle2' });
    const companyName = await page.evaluate(() => document.querySelector('.company-name')?.textContent.trim());
    const match = similarity.compareTwoStrings(companyName || '', name) > 0.8 || (nameAlt && similarity.compareTwoStrings(companyName || '', nameAlt) > 0.8);
    if (!match) throw new Error('Name mismatch');
    const data = await page.evaluate(() => ({
      price: parseFloat(document.querySelector('.stock-price')?.textContent.replace(/[^0-9.]/g, '') || '0'),
      marketCap: parseFloat(document.querySelector('.market-cap')?.textContent.replace(/[^0-9.]/g, '') || '0') * (document.querySelector('.market-cap')?.textContent.includes('B') ? 1e9 : 1e6)
    }));
    await browser.close();
    return { price: data.price || null, marketCap: data.marketCap || null, currency: 'CAD' };
  } catch (e) {
    console.error(`MiningFeeds fetch failed for ${ticker}: ${e}`);
    await browser.close();
    return { price: null, marketCap: null, currency: 'CAD' };
  }
}

async function fetchTradingView(ticker, name, nameAlt) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`https://www.tradingview.com/symbols/${ticker.replace('.', '')}/`, { waitUntil: 'networkidle2' });
    const companyName = await page.evaluate(() => document.querySelector('.tv-header__title')?.textContent.trim());
    const match = similarity.compareTwoStrings(companyName || '', name) > 0.8 || (nameAlt && similarity.compareTwoStrings(companyName || '', nameAlt) > 0.8);
    if (!match) throw new Error('Name mismatch');
    const data = await page.evaluate(() => ({
      price: parseFloat(document.querySelector('.js-symbol-last')?.textContent.replace(/[^0-9.]/g, '') || '0'),
      marketCap: parseFloat(document.querySelector('.tv-market-cap')?.textContent.replace(/[^0-9.]/g, '') || '0') * (document.querySelector('.tv-market-cap')?.textContent.includes('B') ? 1e9 : 1e6)
    }));
    await browser.close();
    return { price: data.price || null, marketCap: data.marketCap || null, currency: 'CAD' };
  } catch (e) {
    console.error(`TradingView fetch failed for ${ticker}: ${e}`);
    await browser.close();
    return { price: null, marketCap: null, currency: 'CAD' };
  }
}

async function resolveData(ticker, jmn, yahoo, mf, tv, shares) {
  const log = [`[${ticker}] - ${new Date().toISOString().split('T')[0]}`];
  
  const validPrices = [jmn.price, yahoo.currency === 'CAD' ? yahoo.price : null, mf.price, tv.price].filter(p => p > 0);
  const priceVariance = validPrices.length > 1 ? Math.max(...validPrices.map(p => Math.abs(p - (jmn.price || yahoo.price)) / (jmn.price || yahoo.price))) : 0;
  let finalPrice = jmn.price || yahoo.price || mf.price || tv.price || (validPrices.length ? validPrices.reduce((a, b) => a + b) / validPrices.length : 0);
  log.push(`Stock Price: JMN=${jmn.price || 'N/A'} CAD, Yahoo=${yahoo.price || 'N/A'} ${yahoo.currency}, MF=${mf.price || 'N/A'} CAD, TV=${tv.price || 'N/A'} CAD, Variance=${priceVariance.toFixed(2)}%, Resolved=${finalPrice} CAD`);

  const calculatedMarketCap = finalPrice * shares;
  const validCaps = [jmn.marketCap, yahoo.currency === 'CAD' ? yahoo.marketCap : null, mf.marketCap, tv.marketCap, calculatedMarketCap].filter(c => c > 0);
  const capVariance = validCaps.length > 1 ? Math.max(...validCaps.map(c => Math.abs(c - (jmn.marketCap || yahoo.marketCap)) / (jmn.marketCap || yahoo.marketCap))) : 0;
  let finalMarketCap = jmn.marketCap || yahoo.marketCap || mf.marketCap || tv.marketCap || calculatedMarketCap || (validCaps.length ? validCaps.reduce((a, b) => a + b) / validCaps.length : 0);
  log.push(`Market Cap: JMN=${jmn.marketCap || 'N/A'} CAD, Yahoo=${yahoo.marketCap || 'N/A'} ${yahoo.currency}, MF=${mf.marketCap || 'N/A'} CAD, TV=${tv.marketCap || 'N/A'} CAD, Calc=${calculatedMarketCap} CAD, Variance=${capVariance.toFixed(2)}%, Resolved=${finalMarketCap} CAD`);

  await fs.appendFile(LOG_FILE, log.join('\n') + '\n');
  return { price: finalPrice, marketCap: finalMarketCap };
}

async function updateJsonFile(ticker, data, name) {
  const filePath = path.join(DATA_DIR, `${ticker}.json`);
  let jsonData;
  try {
    jsonData = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (e) {
    jsonData = { name, tsx_code: ticker, number_of_shares: 0 };
  }
  jsonData.stock_price = data.price;
  jsonData.market_cap_value = data.marketCap;
  jsonData.stock_price_currency = 'CAD';
  jsonData.market_cap_currency = 'CAD';
  jsonData.last_updated = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
}

async function main() {
  const csvData = await fs.readFile(CSV_FILE, 'utf8');
  const companies = parse(csvData, { columns: true, skip_empty_lines: true });

  for (const { TICKER: ticker, NAME: name, NAMEALT: nameAlt } of companies.slice(0, 5)) { // Test with first 5
    const jsonPath = path.join(DATA_DIR, `${ticker}.json`);
    const shares = JSON.parse(await fs.readFile(jsonPath, 'utf8').catch(() => '{}')).number_of_shares || 0;
    const [jmn, yahoo, mf, tv] = await Promise.all([
      fetchJuniorMining(ticker, name, nameAlt),
      fetchYahooFinance(ticker, name, nameAlt),
      fetchMiningFeeds(ticker, name, nameAlt),
      fetchTradingView(ticker, name, nameAlt)
    ]);
    const resolved = await resolveData(ticker, jmn, yahoo, mf, tv, shares);
    await updateJsonFile(ticker, resolved, name);
    console.log(`Updated ${ticker}: Price=${resolved.price} CAD, Market Cap=${resolved.marketCap} CAD`);
    await new Promise(r => setTimeout(r, 3000));
  }
}

main().catch(console.error);
