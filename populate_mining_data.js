const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';
const TEST_TICKERS = ['AAB.TO', 'AAG.V', 'AAN.V'];
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36'
];

async function delay(ms, message = 'Delaying') {
  const randomDelay = ms + Math.floor(Math.random() * 60000); // Up to 60s randomness
  console.log(`[${new Date().toISOString()}] ${message} for ${randomDelay / 1000}s`);
  return new Promise(resolve => setTimeout(resolve, randomDelay));
}

async function fetchPage(page, url, ticker, source, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[${new Date().toISOString()}] Attempt ${i + 1} to fetch ${source} for ${ticker}`);
      await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      if (response.status() === 429) throw new Error('HTTP 429 - Too Many Requests');
      return await page.content();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] ${source} failed: ${e.message}`);
      if (i < retries - 1) await delay(60000, `Retrying ${source} for ${ticker}`);
      else throw e;
    }
  }
}

async function extractMiningData(ticker, name) {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  let data = { reserves_au_moz: 0, resources_au_moz: 0, production_total_au_eq_koz: 0, aisc_last_year_value: 0 };

  // SEDAR+ Search
  try {
    await page.goto('https://www.sedarplus.ca/landingpage/', { waitUntil: 'networkidle2' });
    await page.type('input[name="searchText"]', name, { delay: 150 });
    await page.select('select[name="searchType"]', 'company');
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    const profileUrl = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('View Profile'))?.href
    );
    if (profileUrl) {
      await page.goto(profileUrl, { waitUntil: 'networkidle2' });
      await page.waitForSelector('a[href*="public-view"]', { timeout: 10000 });
      await page.click('a[href*="public-view"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
      const reportUrl = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a')).find(a => a.textContent.toLowerCase().includes('ni 43-101'))?.href
      );
      if (reportUrl) {
        const content = await fetchPage(page, reportUrl, ticker, 'SEDAR+ Report');
        data.reserves_au_moz = parseFloat(content.match(/reserves\s*[:=]\s*(\d+\.?\d*)\s*million\s*ounces/i)?.[1]) || 0;
        data.resources_au_moz = parseFloat(content.match(/resources\s*[:=]\s*(\d+\.?\d*)\s*million\s*ounces/i)?.[1]) || 0;
      }
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] SEDAR+ failed for ${ticker}: ${e.message}`);
  }
  await delay(60000, `Post-SEDAR+ pause for ${ticker}`);

  // Google Investor Relations
  try {
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(name)}+investor+relations+site:*.ca+-inurl:(signup+login)`;
    const content = await fetchPage(page, googleUrl, ticker, 'Google IR');
    const irUrl = content.match(/href="(https?:\/\/[^"]*investor[^"]*)"/)?.[1];
    if (irUrl) {
      const irContent = await fetchPage(page, irUrl, ticker, 'Investor Relations');
      data.production_total_au_eq_koz = parseFloat(irContent.match(/production\s*[:=]\s*(\d+\.?\d*)\s*(thousand\s*ounces|koz)/i)?.[1]) || 0;
      data.aisc_last_year_value = parseFloat(irContent.match(/aisc\s*[:=]\s*\$?(\d+\.?\d*)/i)?.[1]) || 0;
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Google IR failed for ${ticker}: ${e.message}`);
  }
  await delay(60000, `Post-Google pause for ${ticker}`);

  // MiningFeeds
  try {
    const exchange = ticker.endsWith('.TO') ? 'tsx' : 'tsxv';
    const miningUrl = `https://www.miningfeeds.com/stock/${name.toLowerCase().replace(/\s+/g, '-')}-${exchange}`;
    const content = await fetchPage(page, miningUrl, ticker, 'MiningFeeds');
    data.production_total_au_eq_koz = parseFloat(content.match(/production\s*[:=]\s*(\d+\.?\d*)\s*koz/i)?.[1]) || data.production_total_au_eq_koz;
    data.aisc_last_year_value = parseFloat(content.match(/aisc\s*[:=]\s*\$?(\d+\.?\d*)/i)?.[1]) || data.aisc_last_year_value;
  } catch (e) {
    console.error(`[${new Date().toISOString()}] MiningFeeds failed for ${ticker}: ${e.message}`);
  }

  await browser.close();
  return data;
}

async function updateJson(ticker, data) {
  const filePath = path.join(DATA_DIR, `${ticker}.json`);
  let jsonData = {};
  try {
    jsonData = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    jsonData = { name: ticker, tsx_code: ticker };
  }
  Object.assign(jsonData, data, { last_updated_mining: new Date().toISOString() });
  await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
  console.log(`[${new Date().toISOString()}] Updated ${ticker}.json`);
}

async function main() {
  const csvData = await fs.readFile(CSV_FILE, 'utf8');
  const companies = parse(csvData, { columns: true });
  const testCompanies = companies.filter(c => TEST_TICKERS.includes(c.TICKER));
  for (const { TICKER: ticker, NAME: name } of testCompanies) {
    console.log(`[${new Date().toISOString()}] Processing ${ticker} (${name})`);
    const data = await extractMiningData(ticker, name);
    await updateJson(ticker, data);
    await delay(60000, `Between tickers pause after ${ticker}`);
  }
  console.log(`[${new Date().toISOString()}] Done!`);
}

main().catch(err => console.error(`[${new Date().toISOString()}] Error: ${err.message}`));
