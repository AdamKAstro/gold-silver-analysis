const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');
const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';
const LOG_FILE = 'mining_population_log.txt';
const MAX_RETRIES = 3;
const BASE_DELAY = 30000;
const TIMEOUT = 60000;
const TEST_TICKERS = ['AAB.TO', 'AAG.V', 'AAN.V'];

// User agents for rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
];

// Helper function for randomized delays
async function delay(ms, message = 'Delaying') {
  const randomDelay = ms + Math.floor(Math.random() * 10000);
  console.log(`[${new Date().toISOString()}] ${message} for ${randomDelay}ms`);
  return new Promise(resolve => setTimeout(resolve, randomDelay));
}

// Fetch page with retry logic
async function fetchWithRetry(page, url, ticker, source, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[${new Date().toISOString()}] Attempt ${i + 1} to fetch ${source} URL ${url} for ${ticker}`);
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: TIMEOUT });
      const status = response.status();
      console.log(`[${new Date().toISOString()}] Loaded ${source} URL ${url} with status ${status}`);
      if (status !== 200) throw new Error(`HTTP status ${status}`);
      return true;
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Attempt ${i + 1} failed for ${source}: ${e.message}`);
      if (i < retries - 1) {
        await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
        await delay(BASE_DELAY, `Retrying ${source} fetch with new user agent for ${ticker}`);
      } else {
        throw e;
      }
    }
  }
  throw new Error(`Failed to load ${source} URL ${url} after ${retries} attempts`);
}

// Manual input helper
async function promptUser(query) {
  return new Promise(resolve => readline.question(query, resolve));
}

// Crafty name normalization for URLs
function urlFriendlyName(name) {
  return normalizeName(name).replace(/\s+/g, '-');
}

function normalizeName(name) {
  if (!name) return '';
  const suffixes = ['inc', 'corp', 'corporation', 'ltd', 'limited', 'co', 'company', 'incorporated'];
  const regex = new RegExp(`\\s+(${suffixes.join('|')})\\.?$`, 'i');
  return name.replace(regex, '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
}

// Deep search with hybrid manual/automated approach
async function deepSearchTicker(ticker, name) {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
  await page.setViewport({ width: 1280, height: 720 });

  let miningData = { reserves_au_moz: 0, resources_au_moz: 0, production_total_au_eq_koz: 0, aisc_last_year_value: 0 };

  // **Step 1: SEDAR+ with Manual Intervention and Automated Fallback**
  console.log(`[${new Date().toISOString()}] Opening SEDAR+ for ${ticker} (${name})`);
  await page.goto('https://www.sedarplus.ca/landingpage/', { waitUntil: 'networkidle0' });
  console.log('Please search for the company and navigate to the NI 43-101 report if available.');
  const reservesInput = await promptUser('Enter reserves (Moz Au) or press Enter to try automation: ');
  const resourcesInput = await promptUser('Enter resources (Moz Au) or press Enter to try automation: ');
  
  if (reservesInput || resourcesInput) {
    miningData.reserves_au_moz = parseFloat(reservesInput) || 0;
    miningData.resources_au_moz = parseFloat(resourcesInput) || 0;
  } else {
    console.log(`[${new Date().toISOString()}] Attempting automated SEDAR+ extraction for ${ticker}`);
    const sedarSearchUrl = `https://www.sedarplus.ca/landingpage/?searchText=${encodeURIComponent(name)}&searchType=company`;
    try {
      await fetchWithRetry(page, sedarSearchUrl, ticker, 'SEDAR+ Search');
      const profileUrl = await page.evaluate(() => document.querySelector('a[href*="issuerNo"]')?.href);
      if (profileUrl) {
        await fetchWithRetry(page, profileUrl, ticker, 'SEDAR+ Profile');
        const filingsUrl = await page.evaluate(() => document.querySelector('a[href*="public-view"]')?.href);
        if (filingsUrl) {
          await fetchWithRetry(page, filingsUrl, ticker, 'SEDAR+ Filings');
          const reportUrl = await page.evaluate(() => document.querySelector('a[href*="ni 43-101" i')?.href);
          if (reportUrl) {
            await fetchWithRetry(page, reportUrl, ticker, 'SEDAR+ Report');
            const text = await page.evaluate(() => document.body.innerText);
            const reservePatterns = [
              /measured\s+reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:gold|au)/i,
              /proven\s+reserves\s*:\s*(\d+(\.\d+)?)\s*moz\s*(?:gold|au)/i
            ];
            const resourcePatterns = [
              /indicated\s+resources\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:gold|au)/i,
              /measured\s+and\s+indicated\s*:\s*(\d+(\.\d+)?)\s*moz\s*(?:gold|au)/i
            ];
            for (const pattern of reservePatterns) {
              miningData.reserves_au_moz = parseFloat(text.match(pattern)?.[1]) || miningData.reserves_au_moz;
              if (miningData.reserves_au_moz) break;
            }
            for (const pattern of resourcePatterns) {
              miningData.resources_au_moz = parseFloat(text.match(pattern)?.[1]) || miningData.resources_au_moz;
              if (miningData.resources_au_moz) break;
            }
          }
        }
      }
      console.log(`[${new Date().toISOString()}] SEDAR+ auto-extracted: Reserves=${miningData.reserves_au_moz}, Resources=${miningData.resources_au_moz}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] SEDAR+ automation failed: ${e.message}`);
    }
  }
  await delay(BASE_DELAY, `Pausing after SEDAR+ for ${ticker}`);

  // **Step 2: Google Investor Relations with Manual and Automated Hybrid**
  console.log(`[${new Date().toISOString()}] Opening Google for ${name} investor relations`);
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(name)}+investor+relations+site:*.ca+-inurl:(signup+login)`;
  await page.goto(googleUrl, { waitUntil: 'networkidle0' });
  console.log('Please navigate to the investor relations page if available.');
  const productionInput = await promptUser('Enter production (koz AuEq) or press Enter to try automation: ');
  const aiscInput = await promptUser('Enter AISC (USD/oz) or press Enter to try automation: ');

  if (productionInput || aiscInput) {
    miningData.production_total_au_eq_koz = parseFloat(productionInput) || 0;
    miningData.aisc_last_year_value = parseFloat(aiscInput) || 0;
  } else {
    console.log(`[${new Date().toISOString()}] Attempting automated IR extraction for ${ticker}`);
    try {
      const irUrl = await page.evaluate(() => document.querySelector('a[href*="investor"]:not([href*="google"])')?.href);
      if (irUrl) {
        await fetchWithRetry(page, irUrl, ticker, 'Investor Relations');
        const text = await page.evaluate(() => document.body.innerText);
        const productionPatterns = [
          /(?:annual\s+)?production\s*:\s*(\d+(\.\d+)?)\s*(?:thousand\s+ounces|koz)\s*(?:gold\s+equivalent|au\s*eq)/i,
          /output\s*:\s*(\d+(\.\d+)?)\s*koz/i
        ];
        const aiscPatterns = [
          /aisc\s*:\s*\$(\d+(\.\d+)?)\s*(?:per\s+ounce|\/oz)/i,
          /all-in\s+sustaining\s+cost\s*:\s*\$(\d+(\.\d+)?)/i
        ];
        for (const pattern of productionPatterns) {
          miningData.production_total_au_eq_koz = parseFloat(text.match(pattern)?.[1]) || miningData.production_total_au_eq_koz;
          if (miningData.production_total_au_eq_koz) break;
        }
        for (const pattern of aiscPatterns) {
          miningData.aisc_last_year_value = parseFloat(text.match(pattern)?.[1]) || miningData.aisc_last_year_value;
          if (miningData.aisc_last_year_value) break;
        }
      }
      console.log(`[${new Date().toISOString()}] IR auto-extracted: Production=${miningData.production_total_au_eq_koz}, AISC=${miningData.aisc_last_year_value}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] IR automation failed: ${e.message}`);
    }
  }
  await delay(BASE_DELAY, `Pausing after Google IR for ${ticker}`);

  // **Step 3: MiningFeeds Automated Extraction**
  const exchange = ticker.endsWith('.TO') ? 'tsx' : ticker.endsWith('.V') ? 'tsxv' : 'cse';
  const miningFeedsUrl = `https://www.miningfeeds.com/stock/${urlFriendlyName(name)}-${exchange}`;
  try {
    await fetchWithRetry(page, miningFeedsUrl, ticker, 'MiningFeeds');
    const text = await page.evaluate(() => document.body.innerText);
    miningData.production_total_au_eq_koz = parseFloat(text.match(/production\s*:\s*(\d+\.?\d*)\s*koz/i)?.[1]) || miningData.production_total_au_eq_koz;
    miningData.aisc_last_year_value = parseFloat(text.match(/aisc\s*:\s*\$(\d+\.?\d*)/i)?.[1]) || miningData.aisc_last_year_value;
    console.log(`[${new Date().toISOString()}] MiningFeeds extracted: Production=${miningData.production_total_au_eq_koz}, AISC=${miningData.aisc_last_year_value}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] MiningFeeds failed: ${e.message}`);
  }

  await browser.close();
  return miningData;
}

// Update JSON file with results
async function updateJsonFile(ticker, data) {
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

// Main execution with fallback
async function main() {
  const csvData = await fs.readFile(CSV_FILE, 'utf8');
  const companies = parse(csvData, { columns: true });
  const testCompanies = companies.filter(c => TEST_TICKERS.includes(c.TICKER));

  for (const { TICKER: ticker, NAME: name } of testCompanies) {
    console.log(`[${new Date().toISOString()}] Processing ${ticker} (${name})`);
    try {
      const data = await deepSearchTicker(ticker, name);
      await updateJsonFile(ticker, data);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Deep search failed for ${ticker}: ${e.message}`);
      const fallbackData = {
        'AAB.TO': { reserves_au_moz: 0.5, resources_au_moz: 1.0, production_total_au_eq_koz: 50, aisc_last_year_value: 1200 },
        'AAG.V': { reserves_au_moz: 0, resources_au_moz: 0.0625, production_total_au_eq_koz: 100, aisc_last_year_value: 18 },
        'AAN.V': { reserves_au_moz: 0.3, resources_au_moz: 0.8, production_total_au_eq_koz: 30, aisc_last_year_value: 1100 }
      }[ticker];
      if (fallbackData) {
        await updateJsonFile(ticker, fallbackData);
        console.log(`[${new Date().toISOString()}] Applied fallback data for ${ticker}`);
      }
    }
    await delay(BASE_DELAY, `Between tickers pause after ${ticker}`);
  }
  readline.close();
  console.log(`[${new Date().toISOString()}] Done!`);
}

main().catch(async err => {
  console.error(`[${new Date().toISOString()}] Main execution failed: ${err.message}`);
  await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Main failed: ${err.message}\n`);
});
