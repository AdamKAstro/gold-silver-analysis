const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');

const TEST_TICKERS = ['AAB.TO', 'AAG.V', 'AAN.V']; // Sample tickers to test
const LOG_FILE = 'test_fetch_log.txt';

// Normalize company names for URL construction
function normalizeName(name) {
  if (!name) return '';
  const suffixes = ['inc', 'corp', 'corporation', 'ltd', 'limited', 'co', 'company', 'incorporated'];
  const regex = new RegExp(`\\s+(${suffixes.join('|')})\\.?$`, 'i');
  return name.replace(regex, '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
}

function urlFriendlyName(name) {
  return normalizeName(name).replace(/\s+/g, '-');
}

// Cross-version delay function
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generic fetch with retry logic
async function fetchWithRetry(page, url, retries = 3, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      const status = response.status();
      if (status !== 200) throw new Error(`HTTP status ${status}`);
      return status;
    } catch (e) {
      console.warn(`Attempt ${i + 1} failed for ${url}: ${e}`);
      if (i < retries - 1) await delay(delayMs);
    }
  }
  throw new Error(`Failed to load ${url} after ${retries} attempts`);
}

// Test methods for TradingView
async function testTradingView(ticker, name) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const exchange = ticker.endsWith('.TO') ? 'TSX' : ticker.endsWith('.V') ? 'TSXV' : 'CSE';
  const cleanTicker = ticker.replace('.', '-');
  const url = `https://www.tradingview.com/symbols/${exchange}-${cleanTicker}/`;
  const results = [];

  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  // Method 1: Basic fetch with proven selector
  try {
    const status = await fetchWithRetry(page, url);
    await page.waitForSelector('.js-symbol-last', { timeout: 60000 });
    const price = await page.evaluate(() => document.querySelector('.js-symbol-last')?.textContent.trim() || 'N/A');
    const title = await page.title();
    results.push(`Method 1: Basic fetch - Status: ${status}, Title: ${title}, Price: ${price}`);
  } catch (e) {
    results.push(`Method 1: Basic fetch failed - ${e.message}`);
    const content = await page.content();
    results.push(`HTML Dump: ${content.slice(0, 500)}`);
  }

  // Method 2: Dynamic wait on price
  try {
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => {
      const priceEl = document.querySelector('.js-symbol-last');
      return priceEl && priceEl.textContent.trim() !== '';
    }, { timeout: 60000 });
    const price = await page.evaluate(() => document.querySelector('.js-symbol-last')?.textContent.trim() || 'N/A');
    const title = await page.title();
    results.push(`Method 2: Dynamic wait - Title: ${title}, Price: ${price}`);
  } catch (e) {
    results.push(`Method 2: Dynamic wait failed - ${e.message}`);
    const content = await page.content();
    results.push(`HTML Dump: ${content.slice(0, 500)}`);
  }

  // Method 3: Alternative selector with delay
  try {
    await page.goto(url, { waitUntil: 'networkidle0' });
    await delay(5000);
    const price = await page.evaluate(() => document.querySelector('.js-symbol-last')?.textContent.trim() || 'N/A');
    const title = await page.title();
    results.push(`Method 3: Alternative selector with delay - Title: ${title}, Price: ${price}`);
  } catch (e) {
    results.push(`Method 3: Alternative selector failed - ${e.message}`);
    const content = await page.content();
    results.push(`HTML Dump: ${content.slice(0, 500)}`);
  }

  await browser.close();
  await logResults(`TradingView - ${ticker} (${name})`, results);
}

// Test methods for MiningFeeds
async function testMiningFeeds(ticker, name) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const exchange = ticker.endsWith('.TO') ? 'tsx' : ticker.endsWith('.V') ? 'tsxv' : 'cse';
  const urlName = urlFriendlyName(name);
  const singleUrl = `https://www.miningfeeds.com/stock/${urlName}-${exchange}/`;
  const goldReportUrls = Array.from({ length: 8 }, (_, i) => `https://www.miningfeeds.com/gold-mining-report-all-countries/?xpage=${i + 1}`);
  const silverReportUrls = Array.from({ length: 8 }, (_, i) => `https://www.miningfeeds.com/silver-mining-report-all-countries/?xpage=${i + 1}`);
  const results = [];

  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  // Method 1: Single stock page with standard selector
  try {
    const status = await fetchWithRetry(page, singleUrl);
    await page.waitForSelector('.stock-meta .price', { timeout: 60000 });
    const price = await page.evaluate(() => document.querySelector('.stock-meta .price')?.textContent.trim() || 'N/A');
    const title = await page.title();
    results.push(`Method 1: Single page fetch - Status: ${status}, Title: ${title}, Price: ${price}`);
  } catch (e) {
    results.push(`Method 1: Single page fetch failed - ${e.message}`);
    const content = await page.content();
    results.push(`HTML Dump: ${content.slice(0, 500)}`);
  }

  // Method 2: Gold report pages
  for (const url of goldReportUrls) {
    try {
      const status = await fetchWithRetry(page, url);
      await page.waitForSelector('.mining-table tbody tr', { timeout: 60000 }); // Assuming table class
      const price = await page.evaluate((t) => {
        const rows = Array.from(document.querySelectorAll('.mining-table tbody tr'));
        const row = rows.find(r => r.querySelector('.ticker')?.textContent.trim() === t);
        return row ? row.querySelector('.price')?.textContent.trim() || 'N/A' : 'N/A';
      }, ticker);
      const title = await page.title();
      results.push(`Method 2: Gold report (${url.split('xpage=')[1]}) - Status: ${status}, Title: ${title}, Price: ${price}`);
    } catch (e) {
      results.push(`Method 2: Gold report (${url.split('xpage=')[1]}) failed - ${e.message}`);
      const content = await page.content();
      results.push(`HTML Dump: ${content.slice(0, 500)}`);
    }
  }

  // Method 3: Silver report pages
  for (const url of silverReportUrls) {
    try {
      const status = await fetchWithRetry(page, url);
      await page.waitForSelector('.mining-table tbody tr', { timeout: 60000 });
      const price = await page.evaluate((t) => {
        const rows = Array.from(document.querySelectorAll('.mining-table tbody tr'));
        const row = rows.find(r => r.querySelector('.ticker')?.textContent.trim() === t);
        return row ? row.querySelector('.price')?.textContent.trim() || 'N/A' : 'N/A';
      }, ticker);
      const title = await page.title();
      results.push(`Method 3: Silver report (${url.split('xpage=')[1]}) - Status: ${status}, Title: ${title}, Price: ${price}`);
    } catch (e) {
      results.push(`Method 3: Silver report (${url.split('xpage=')[1]}) failed - ${e.message}`);
      const content = await page.content();
      results.push(`HTML Dump: ${content.slice(0, 500)}`);
    }
  }

  await browser.close();
  await logResults(`MiningFeeds - ${ticker} (${name})`, results);
}

// Test methods for Junior Mining Network
async function testJuniorMining(ticker, name) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const urls = [
    'https://www.juniorminingnetwork.com/mining-stocks/gold-mining-stocks.html',
    'https://www.juniorminingnetwork.com/mining-stocks/silver-mining-stocks.html'
  ];
  const results = [];

  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  for (const url of urls) {
    // Method 1: Basic fetch with table selector
    try {
      const status = await fetchWithRetry(page, url);
      await page.waitForSelector('.stock-table tbody tr', { timeout: 60000 });
      const price = await page.evaluate((t) => {
        const rows = Array.from(document.querySelectorAll('.stock-table tbody tr'));
        const row = rows.find(r => r.querySelector('.ticker')?.textContent.trim() === t);
        return row ? row.querySelector('.last-trade')?.textContent.trim() || 'N/A' : 'N/A';
      }, ticker);
      const title = await page.title();
      results.push(`Method 1: Basic fetch (${url.split('/').pop()}) - Status: ${status}, Title: ${title}, Price: ${price}`);
    } catch (e) {
      results.push(`Method 1: Basic fetch (${url.split('/').pop()}) failed - ${e.message}`);
      const content = await page.content();
      results.push(`HTML Dump: ${content.slice(0, 500)}`);
    }

    // Method 2: Dynamic wait on price
    try {
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.waitForFunction((t) => {
        const rows = Array.from(document.querySelectorAll('.stock-table tbody tr'));
        const row = rows.find(r => r.querySelector('.ticker')?.textContent.trim() === t);
        return row && row.querySelector('.last-trade')?.textContent.trim() !== '';
      }, { timeout: 60000 }, ticker);
      const price = await page.evaluate((t) => {
        const rows = Array.from(document.querySelectorAll('.stock-table tbody tr'));
        const row = rows.find(r => r.querySelector('.ticker')?.textContent.trim() === t);
        return row ? row.querySelector('.last-trade')?.textContent.trim() || 'N/A' : 'N/A';
      }, ticker);
      const title = await page.title();
      results.push(`Method 2: Dynamic wait (${url.split('/').pop()}) - Title: ${title}, Price: ${price}`);
    } catch (e) {
      results.push(`Method 2: Dynamic wait (${url.split('/').pop()}) failed - ${e.message}`);
      const content = await page.content();
      results.push(`HTML Dump: ${content.slice(0, 500)}`);
    }
  }

  await browser.close();
  await logResults(`JuniorMining - ${ticker} (${name})`, results);
}

async function logResults(source, results) {
  const timestamp = new Date().toISOString();
  const logEntry = `\n[${timestamp}] ${source}\n${results.join('\n')}\n`;
  console.log(logEntry);
  await fs.appendFile(LOG_FILE, logEntry);
}

async function main() {
  const testCompanies = [
    { ticker: 'AAB.TO', name: 'ABERDEEN INTERNATIONAL' },
    { ticker: 'AAG.V', name: 'AFTERMATH SILVER' },
    { ticker: 'AAN.V', name: 'ATON RESOURCES' }
  ];

  for (const { ticker, name } of testCompanies) {
    await testTradingView(ticker, name);
    await testMiningFeeds(ticker, name);
    await testJuniorMining(ticker, name);
    await delay(10000); // 10-second delay between companies
  }
}

main().catch(error => {
  console.error('Test script failed:', error);
  fs.appendFileSync(LOG_FILE, `\n[${new Date().toISOString()}] Test script failed: ${error.message}\n`);
});