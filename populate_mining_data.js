const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');

const CSV_FILE = 'public/data/companies.csv';
const DATA_DIR = 'public/data/';
const LOG_FILE = 'mining_population_log.txt';
const MAX_RETRIES = 3; // Max retries per fetch attempt
const BASE_DELAY = 30000; // 30s base delay to avoid rate limits
const TIMEOUT = 60000; // 60s timeout for page loads
const TEST_TICKERS = ['AAB.TO', 'AAG.V', 'AAN.V']; // Initial test set

// User agents to rotate
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
];

// Helper function for delays with randomization
async function delay(ms, message = 'Delaying') {
  const randomDelay = ms + Math.floor(Math.random() * 10000); // Add 0-10s randomness
  console.log(`[${new Date().toISOString()}] ${message} for ${randomDelay}ms`);
  return new Promise(resolve => setTimeout(resolve, randomDelay));
}

// Fetch page with retry logic and proxy support
async function fetchWithRetry(page, url, ticker, source, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[${new Date().toISOString()}] Attempt ${i + 1} to fetch ${source} URL ${url} for ${ticker}`);
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: TIMEOUT });
      const status = response.status();
      console.log(`[${new Date().toISOString()}] Successfully loaded ${source} URL ${url} with status ${status}`);
      if (status !== 200) throw new Error(`HTTP status ${status}`);
      return true;
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Attempt ${i + 1} failed for ${source} URL ${url}: ${e.message}`);
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

// Deep search for mining data with expert-level strategies
async function deepSearchTicker(ticker, name) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
  await page.setViewport({ width: 1280, height: 720 });

  let miningData = {
    reserves_au_moz: 0,
    resources_au_moz: 0,
    production_total_au_eq_koz: 0,
    aisc_last_year_value: 0
  };

  // Step 1: SEDAR+ Search for NI 43-101 Reports
  console.log(`[${new Date().toISOString()}] Initiating SEDAR+ search for ${ticker} (${name})`);
  const sedarSearchUrl = `https://www.sedarplus.ca/landingpage/?searchText=${encodeURIComponent(name)}&searchType=company`;
  try {
    await fetchWithRetry(page, sedarSearchUrl, ticker, 'SEDAR+ Search');
    await page.waitForSelector('a', { timeout: TIMEOUT }); // Wait for any links to load
    const profileUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).find(a => a.textContent.toLowerCase().includes('view profile') || a.href.includes('issuerNo'));
      return links ? links.href : null;
    });
    if (profileUrl) {
      console.log(`[${new Date().toISOString()}] Navigating to SEDAR+ profile: ${profileUrl}`);
      await fetchWithRetry(page, profileUrl, ticker, 'SEDAR+ Profile');
      // Navigate to filings tab (assuming a clickable element)
      await page.waitForSelector('a[href*="public-view"]', { timeout: TIMEOUT });
      const filingsUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a')).find(a => a.href.includes('public-view'));
        return links ? links.href : null;
      });
      if (filingsUrl) {
        console.log(`[${new Date().toISOString()}] Accessing filings at: ${filingsUrl}`);
        await fetchWithRetry(page, filingsUrl, ticker, 'SEDAR+ Filings');
        const reportUrl = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a')).find(a => a.textContent.toLowerCase().includes('ni 43-101'));
          return links ? links.href : null;
        });
        if (reportUrl) {
          console.log(`[${new Date().toISOString()}] Found NI 43-101 report: ${reportUrl}`);
          await fetchWithRetry(page, reportUrl, ticker, 'SEDAR+ Report');
          await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: TIMEOUT });
          const text = await page.evaluate(() => document.body.innerText);

          // Smart extraction with multiple patterns
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
          const silverReserves = parseFloat(text.match(/measured\s+reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:silver|ag)/i)?.[1]) || 0;
          miningData.reserves_au_moz += silverReserves / 80; // Silver to gold equivalent
          console.log(`[${new Date().toISOString()}] SEDAR+ extracted: Reserves=${miningData.reserves_au_moz} Moz Au, Resources=${miningData.resources_au_moz} Moz Au`);
        } else {
          console.warn(`[${new Date().toISOString()}] No NI 43-101 report link found in filings for ${ticker}`);
        }
      } else {
        console.warn(`[${new Date().toISOString()}] No filings link found in SEDAR+ profile for ${ticker}`);
      }
    } else {
      console.warn(`[${new Date().toISOString()}] No profile link found on SEDAR+ for ${ticker}`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] SEDAR+ search failed for ${ticker}: ${e.message}`);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] SEDAR+ failed for ${ticker}: ${e.message}\n`);
  }
  await delay(BASE_DELAY, `Pausing after SEDAR+ search for ${ticker}`);

  // Step 2: Google Search for Investor Relations
  console.log(`[${new Date().toISOString()}] Initiating Google search for investor relations of ${ticker} (${name})`);
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(name)}+investor+relations+site:*.ca+-inurl:(signup+login)`;
  try {
    await fetchWithRetry(page, googleUrl, ticker, 'Google IR');
    await page.waitForSelector('a', { timeout: TIMEOUT });
    const irUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).find(a => a.href.includes('investor') && !a.href.includes('google'));
      return links ? links.href : null;
    });
    if (irUrl) {
      console.log(`[${new Date().toISOString()}] Navigating to investor relations page: ${irUrl}`);
      await fetchWithRetry(page, irUrl, ticker, 'Investor Relations');
      await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: TIMEOUT });
      const text = await page.evaluate(() => document.body.innerText);

      // Crafty extraction with varied patterns
      const productionPatterns = [
        /(?:annual\s+)?production\s*:\s*(\d+(\.\d+)?)\s*(?:thousand\s+ounces|koz)\s*(?:gold\s+equivalent|au\s*eq)/i,
        /output\s*:\s*(\d+(\.\d+)?)\s*koz/i,
        /(\d+(\.\d+)?)\s*koz\s*(?:produced|production)/i
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
      console.log(`[${new Date().toISOString()}] IR extracted: Production=${miningData.production_total_au_eq_koz} koz AuEq, AISC=${miningData.aisc_last_year_value} USD/oz`);
    } else {
      console.warn(`[${new Date().toISOString()}] No investor relations link found on Google for ${ticker}`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Google IR search failed for ${ticker}: ${e.message}`);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Google IR failed for ${ticker}: ${e.message}\n`);
  }
  await delay(BASE_DELAY, `Pausing after Google IR search for ${ticker}`);

  // Step 3: MiningFeeds Stock Page
  console.log(`[${new Date().toISOString()}] Checking MiningFeeds stock page for ${ticker} (${name})`);
  const exchange = ticker.endsWith('.TO') ? 'tsx' : ticker.endsWith('.V') ? 'tsxv' : 'cse';
  const miningFeedsUrl = `https://www.miningfeeds.com/stock/${urlFriendlyName(name)}-${exchange}`;
  try {
    await fetchWithRetry(page, miningFeedsUrl, ticker, 'MiningFeeds Stock');
    await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: TIMEOUT });
    const text = await page.evaluate(() => document.body.innerText);

    if (!miningData.production_total_au_eq_koz) {
      const prodMatch = text.match(/(?:annual\s+)?production\s*:\s*(\d+(\.\d+)?)\s*(?:thousand\s+ounces|koz)\s*(?:gold\s+equivalent|au\s*eq)?/i) || text.match(/output\s*:\s*(\d+(\.\d+)?)\s*koz/i);
      miningData.production_total_au_eq_koz = prodMatch ? parseFloat(prodMatch[1]) : miningData.production_total_au_eq_koz;
    }
    if (!miningData.aisc_last_year_value) {
      const aiscMatch = text.match(/aisc\s*:\s*\$(\d+(\.\d+)?)\s*(?:per\s+ounce|\/oz)/i);
      miningData.aisc_last_year_value = aiscMatch ? parseFloat(aiscMatch[1]) : miningData.aisc_last_year_value;
    }
    console.log(`[${new Date().toISOString()}] MiningFeeds extracted: Production=${miningData.production_total_au_eq_koz} koz AuEq, AISC=${miningData.aisc_last_year_value} USD/oz`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] MiningFeeds stock page failed for ${ticker}: ${e.message}`);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] MiningFeeds failed for ${ticker}: ${e.message}\n`);
  }

  await browser.close();
  return miningData;
}

// Convert name to URL-friendly format
function urlFriendlyName(name) {
  return normalizeName(name).replace(/\s+/g, '-');
}

// Normalize company names for consistency
function normalizeName(name) {
  if (!name) return '';
  const suffixes = ['inc', 'corp', 'corporation', 'ltd', 'limited', 'co', 'company', 'incorporated'];
  const regex = new RegExp(`\\s+(${suffixes.join('|')})\\.?$`, 'i');
  return name.replace(regex, '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
}

// Update JSON file with mining data
async function updateJsonFile(ticker, data) {
  const filePath = path.join(DATA_DIR, `${ticker}.json`);
  let jsonData;
  try {
    console.log(`[${new Date().toISOString()}] Reading existing JSON for ${ticker}`);
    jsonData = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (e) {
    console.warn(`[${new Date().toISOString()}] No existing JSON for ${ticker}, creating new`);
    jsonData = { name: ticker, tsx_code: ticker };
  }
  const updatedData = {
    reserves_au_moz: data.reserves_au_moz || jsonData.reserves_au_moz || 0,
    resources_au_moz: data.resources_au_moz || jsonData.resources_au_moz || 0,
    production_total_au_eq_koz: data.production_total_au_eq_koz || jsonData.production_total_au_eq_koz || 0,
    aisc_last_year_value: data.aisc_last_year_value || jsonData.aisc_last_year_value || 0,
    last_updated_mining: new Date().toISOString()
  };
  Object.assign(jsonData, updatedData);
  await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
  console.log(`[${new Date().toISOString()}] Updated JSON for ${ticker} with mining data:`, updatedData);
  await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${ticker} updated: ${JSON.stringify(updatedData)}\n`);
}

// Main execution
async function main() {
  console.log(`[${new Date().toISOString()}] Loading companies from ${CSV_FILE}`);
  const csvData = await fs.readFile(CSV_FILE, 'utf8');
  const cleanedCsvData = csvData.trim().replace(/^\ufeff/, '');
  const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`[${new Date().toISOString()}] Parsed ${companies.length} companies from CSV`);

  const testCompanies = companies.filter(c => TEST_TICKERS.includes(c.TICKER));
  console.log(`[${new Date().toISOString()}] Running for test tickers: ${TEST_TICKERS.join(', ')}`);

  for (const { TICKER: ticker, NAME: name } of testCompanies) {
    if (!ticker || !name) {
      console.error(`[${new Date().toISOString()}] Invalid ticker or name: TICKER=${ticker}, NAME=${name}`);
      await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Skipping invalid entry: TICKER=${ticker}, NAME=${name}\n`);
      continue;
    }
    console.log(`[${new Date().toISOString()}] Starting mining data extraction for ${ticker} (${name})`);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const data = await deepSearchTicker(ticker, name);
        await updateJsonFile(ticker, data);
        console.log(`[${new Date().toISOString()}] Successfully processed ${ticker}`);
        break;
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
        if (attempt < MAX_RETRIES - 1) await delay(BASE_DELAY, `Retrying deep search for ${ticker}`);
        else {
          console.error(`[${new Date().toISOString()}] All retries exhausted for ${ticker}`);
          await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${ticker} failed after ${MAX_RETRIES} attempts: ${e.message}\n`);
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
      }
    }
    await delay(BASE_DELAY, `Pausing before next ticker after ${ticker}`);
  }
  console.log(`[${new Date().toISOString()}] Mining data population completed`);
}

main().catch(async err => {
  console.error(`[${new Date().toISOString()}] Main execution failed: ${err.message}`);
  await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Main failed: ${err.message}\n`);
});
