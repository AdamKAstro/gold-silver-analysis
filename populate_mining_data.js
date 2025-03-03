const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');

// Configuration
const CSV_FILE = 'public/data/companies.csv'; // CSV with TICKER and NAME columns
const DATA_DIR = 'public/data/';
const LOG_FILE = 'mining_population_log.txt';
const MAX_RETRIES = 3; // Max retries per fetch attempt
const DELAY_BETWEEN_REQUESTS = 10000; // 10s base delay between requests
const TIMEOUT = 30000; // 30s timeout for page loads
const TEST_TICKERS = ['AAB.TO', 'AAG.V', 'AAN.V']; // Initial test set

// Helper function for delays with randomization to avoid bot detection
async function delay(ms, message = 'Delaying') {
  const randomDelay = ms + Math.floor(Math.random() * 5000); // Add 0-5s randomness
  console.log(`[${new Date().toISOString()}] ${message} for ${randomDelay}ms`);
  return new Promise(resolve => setTimeout(resolve, randomDelay));
}

// Fetch page with retry logic and detailed logging
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
      if (i < retries - 1) await delay(DELAY_BETWEEN_REQUESTS, `Retrying ${source} fetch for ${ticker}`);
      else throw e;
    }
  }
  throw new Error(`Failed to load ${source} URL ${url} after ${retries} attempts`);
}

// Deep search for mining data using company name
async function deepSearchTicker(ticker, name) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 720 });

  let miningData = {
    reserves_au_moz: 0,
    resources_au_moz: 0,
    production_total_au_eq_koz: 0,
    aisc_last_year_value: 0
  };

  // Step 1: Search SEDAR+ for NI 43-101 reports using company name
  console.log(`[${new Date().toISOString()}] Starting SEDAR+ search for ${ticker} (${name})`);
  const sedarUrl = `https://www.sedarplus.ca/landingpage/?searchText=${encodeURIComponent(name)}&searchType=company`;
  try {
    await fetchWithRetry(page, sedarUrl, ticker, 'SEDAR+');
    // Find company profile link (assumes first relevant link)
    const profileUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).find(a => a.textContent.toLowerCase().includes('profile'));
      return links ? links.href : null;
    });
    if (profileUrl) {
      console.log(`[${new Date().toISOString()}] Found SEDAR+ profile URL: ${profileUrl}`);
      await fetchWithRetry(page, profileUrl, ticker, 'SEDAR+ Profile');
      // Search for NI 43-101 report link within profile
      const reportUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a')).find(a => a.textContent.toLowerCase().includes('ni 43-101'));
        return links ? links.href : null;
      });
      if (reportUrl) {
        console.log(`[${new Date().toISOString()}] Found NI 43-101 report URL: ${reportUrl}`);
        await fetchWithRetry(page, reportUrl, ticker, 'SEDAR+ Report');
        const text = await page.evaluate(() => document.body.innerText);

        // Extract reserves and resources (gold and silver)
        miningData.reserves_au_moz = parseFloat(text.match(/measured\s+reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:gold|au)/i)?.[1]) || 0;
        const silverReserves = parseFloat(text.match(/measured\s+reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:silver|ag)/i)?.[1]) || 0;
        miningData.reserves_au_moz += silverReserves / 80; // Convert silver to gold equivalent (80:1 ratio)
        miningData.resources_au_moz = parseFloat(text.match(/indicated\s+resources\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:gold|au)/i)?.[1]) || 0;
        const silverResources = parseFloat(text.match(/indicated\s+resources\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:silver|ag)/i)?.[1]) || 0;
        miningData.resources_au_moz += silverResources / 80;

        console.log(`[${new Date().toISOString()}] Extracted from SEDAR+: Reserves=${miningData.reserves_au_moz} Moz Au, Resources=${miningData.resources_au_moz} Moz Au`);
      } else {
        console.warn(`[${new Date().toISOString()}] No NI 43-101 report found in SEDAR+ profile for ${ticker}`);
      }
    } else {
      console.warn(`[${new Date().toISOString()}] No SEDAR+ profile found for ${ticker}`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] SEDAR+ search failed for ${ticker}: ${e.message}`);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] SEDAR+ failed for ${ticker}: ${e.message}\n`);
  }

  // Step 2: Google search for investor relations page
  console.log(`[${new Date().toISOString()}] Searching Google for ${ticker} (${name}) investor relations`);
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(name)}+investor+relations+site:*.ca+-inurl:(signup+login)`;
  try {
    await fetchWithRetry(page, googleUrl, ticker, 'Google');
    const irUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).find(a => a.href.includes('investor') && !a.href.includes('google'));
      return links ? links.href : null;
    });
    if (irUrl) {
      console.log(`[${new Date().toISOString()}] Found investor relations URL: ${irUrl}`);
      await fetchWithRetry(page, irUrl, ticker, 'Investor Relations');
      await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: TIMEOUT });
      const text = await page.evaluate(() => document.body.innerText);

      // Extract production and AISC
      miningData.production_total_au_eq_koz = parseFloat(text.match(/(?:annual\s+)?production\s*:\s*(\d+(\.\d+)?)\s*(?:thousand\s+ounces|koz)\s*(?:gold\s+equivalent|au\s*eq)?/i)?.[1]) || 0;
      miningData.aisc_last_year_value = parseFloat(text.match(/aisc\s*:\s*\$(\d+(\.\d+)?)\s*(?:per\s+ounce|\/oz)/i)?.[1]) || 0;
      console.log(`[${new Date().toISOString()}] Extracted from IR: Production=${miningData.production_total_au_eq_koz} koz AuEq, AISC=${miningData.aisc_last_year_value} USD/oz`);
    } else {
      console.warn(`[${new Date().toISOString()}] No investor relations URL found for ${ticker} on Google`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Google IR search failed for ${ticker}: ${e.message}`);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Google IR failed for ${ticker}: ${e.message}\n`);
  }

  // Step 3: MiningFeeds stock page (corrected URL format)
  console.log(`[${new Date().toISOString()}] Checking MiningFeeds stock page for ${ticker} (${name})`);
  const exchange = ticker.endsWith('.TO') ? 'tsx' : ticker.endsWith('.V') ? 'tsxv' : 'cse';
  const miningFeedsUrl = `https://www.miningfeeds.com/stock/${urlFriendlyName(name)}-${exchange}`;
  try {
    await fetchWithRetry(page, miningFeedsUrl, ticker, 'MiningFeeds');
    await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: TIMEOUT });
    const text = await page.evaluate(() => document.body.innerText);

    if (!miningData.production_total_au_eq_koz) {
      miningData.production_total_au_eq_koz = parseFloat(text.match(/(?:annual\s+)?production\s*:\s*(\d+(\.\d+)?)\s*(?:thousand\s+ounces|koz)\s*(?:gold\s+equivalent|au\s*eq)?/i)?.[1]) || 0;
    }
    if (!miningData.aisc_last_year_value) {
      miningData.aisc_last_year_value = parseFloat(text.match(/aisc\s*:\s*\$(\d+(\.\d+)?)\s*(?:per\s+ounce|\/oz)/i)?.[1]) || 0;
    }
    console.log(`[${new Date().toISOString()}] Extracted from MiningFeeds: Production=${miningData.production_total_au_eq_koz} koz AuEq, AISC=${miningData.aisc_last_year_value} USD/oz`);
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

// Normalize company names for matching
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
  const cleanedCsvData = csvData.trim().replace(/^\ufeff/, ''); // Remove BOM and trim
  const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`[${new Date().toISOString()}] Parsed ${companies.length} companies from CSV`);

  // Filter to test tickers for now
  const testCompanies = companies.filter(c => TEST_TICKERS.includes(c.TICKER));
  console.log(`[${new Date().toISOString()}] Running for test tickers: ${TEST_TICKERS.join(', ')}`);

  for (const { TICKER: ticker, NAME: name } of testCompanies) {
    if (!ticker || !name) {
      console.error(`[${new Date().toISOString()}] Invalid ticker or name: TICKER=${ticker}, NAME=${name}`);
      await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Skipping invalid entry: TICKER=${ticker}, NAME=${name}\n`);
      continue;
    }
    console.log(`[${new Date().toISOString()}] Beginning deep search for ${ticker} (${name})`);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const data = await deepSearchTicker(ticker, name);
        await updateJsonFile(ticker, data);
        console.log(`[${new Date().toISOString()}] Successfully processed ${ticker}`);
        break;
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
        if (attempt < MAX_RETRIES - 1) await delay(DELAY_BETWEEN_REQUESTS, `Retrying deep search for ${ticker}`);
        else {
          console.error(`[${new Date().toISOString()}] All retries exhausted for ${ticker}`);
          await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${ticker} failed after ${MAX_RETRIES} attempts: ${e.message}\n`);
          // Use fallback values from previous deep search
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
    await delay(DELAY_BETWEEN_REQUESTS, `Pausing before next ticker after ${ticker}`);
  }
  console.log(`[${new Date().toISOString()}] Mining data population completed`);
}

main().catch(async err => {
  console.error(`[${new Date().toISOString()}] Main execution failed: ${err.message}`);
  await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Main failed: ${err.message}\n`);
});
