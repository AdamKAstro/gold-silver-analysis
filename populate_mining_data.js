const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');

// Configuration
const TICKERS = ['AAB.TO', 'AAG.V', 'AAN.V']; // Test tickers; expand to all 153 later
const DATA_DIR = 'public/data/';
const LOG_FILE = 'mining_population_log.txt';
const MAX_RETRIES = 3; // Max retries per fetch attempt
const DELAY_BETWEEN_REQUESTS = 5000; // 5s delay between requests to avoid rate limits
const TIMEOUT = 30000; // 30s timeout for page loads

// Helper function for delays with logging
async function delay(ms, message = 'Delaying') {
  console.log(`[${new Date().toISOString()}] ${message} for ${ms}ms`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch page with retry logic
async function fetchWithRetry(page, url, ticker, source, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[${new Date().toISOString()}] Attempt ${i + 1} to fetch ${source} URL ${url} for ${ticker}`);
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: TIMEOUT });
      const status = response.status();
      if (status !== 200) throw new Error(`HTTP status ${status}`);
      console.log(`[${new Date().toISOString()}] Successfully loaded ${source} URL ${url} with status ${status}`);
      return true;
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Attempt ${i + 1} failed for ${source} URL ${url}: ${e.message}`);
      if (i < retries - 1) await delay(DELAY_BETWEEN_REQUESTS, `Retrying ${source} fetch for ${ticker}`);
    }
  }
  throw new Error(`Failed to load ${source} URL ${url} after ${retries} attempts`);
}

// Deep search for mining data
async function deepSearchTicker(ticker) {
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

  // Step 1: Search SEDAR+ for NI 43-101 reports
  console.log(`[${new Date().toISOString()}] Starting SEDAR+ search for ${ticker}`);
  const sedarUrl = `https://www.sedarplus.ca/search/search_en?search_text=${ticker}`;
  try {
    await fetchWithRetry(page, sedarUrl, ticker, 'SEDAR+');
    const reportUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).filter(a => a.textContent.toLowerCase().includes('ni 43-101'));
      return links.length ? links[0].href : null;
    });
    if (reportUrl) {
      console.log(`[${new Date().toISOString()}] Found NI 43-101 report URL: ${reportUrl}`);
      await fetchWithRetry(page, reportUrl, ticker, 'SEDAR+ Report');
      const text = await page.evaluate(() => document.body.innerText);

      // Extract reserves and resources (gold and silver)
      const goldReserves = text.match(/measured\s+reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:gold|au)/i)?.[1];
      const silverReserves = text.match(/measured\s+reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:silver|ag)/i)?.[1];
      const goldResources = text.match(/indicated\s+resources\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:gold|au)/i)?.[1];
      const silverResources = text.match(/indicated\s+resources\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*(?:silver|ag)/i)?.[1];

      miningData.reserves_au_moz = goldReserves ? parseFloat(goldReserves) : (silverReserves ? parseFloat(silverReserves) / 80 : 0);
      miningData.resources_au_moz = goldResources ? parseFloat(goldResources) : (silverResources ? parseFloat(silverResources) / 80 : 0);
      console.log(`[${new Date().toISOString()}] Extracted from SEDAR+: Reserves=${miningData.reserves_au_moz} Moz Au, Resources=${miningData.resources_au_moz} Moz Au`);
    } else {
      console.warn(`[${new Date().toISOString()}] No NI 43-101 report found on SEDAR+ for ${ticker}`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] SEDAR+ search failed for ${ticker}: ${e.message}`);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] SEDAR+ failed for ${ticker}: ${e.message}\n`);
  }

  // Step 2: Fetch company investor relations page via Google search
  console.log(`[${new Date().toISOString()}] Searching Google for ${ticker} investor relations`);
  const googleUrl = `https://www.google.com/search?q=${ticker}+investor+relations+site:*.ca+-inurl:(signup+login)`;
  try {
    await fetchWithRetry(page, googleUrl, ticker, 'Google');
    const irUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).filter(a => a.href.includes('investor') && !a.href.includes('google'));
      return links.length ? links[0].href : null;
    });
    if (irUrl) {
      console.log(`[${new Date().toISOString()}] Found investor relations URL: ${irUrl}`);
      await fetchWithRetry(page, irUrl, ticker, 'Investor Relations');
      const text = await page.evaluate(() => document.body.innerText);

      // Extract production and AISC
      const productionMatch = text.match(/(?:annual\s+)?production\s*:\s*(\d+(\.\d+)?)\s*(?:thousand\s+ounces|koz)\s*(?:gold\s+equivalent|au\s*eq)?/i);
      const aiscMatch = text.match(/aisc\s*:\s*\$(\d+(\.\d+)?)\s*(?:per\s+ounce|\/oz)/i);
      
      if (productionMatch) miningData.production_total_au_eq_koz = parseFloat(productionMatch[1]);
      if (aiscMatch) miningData.aisc_last_year_value = parseFloat(aiscMatch[1]);
      console.log(`[${new Date().toISOString()}] Extracted from IR: Production=${miningData.production_total_au_eq_koz} koz AuEq, AISC=${miningData.aisc_last_year_value} USD/oz`);
    } else {
      console.warn(`[${new Date().toISOString()}] No investor relations URL found for ${ticker}`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Investor relations search failed for ${ticker}: ${e.message}`);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] IR failed for ${ticker}: ${e.message}\n`);
  }

  // Step 3: Fallback to MiningFeeds news if data is missing
  if (!miningData.production_total_au_eq_koz || !miningData.aisc_last_year_value) {
    console.log(`[${new Date().toISOString()}] Checking MiningFeeds news for ${ticker}`);
    const newsUrl = `https://www.miningfeeds.com/news?ticker=${ticker}`;
    try {
      await fetchWithRetry(page, newsUrl, ticker, 'MiningFeeds');
      const text = await page.evaluate(() => document.body.innerText);
      if (!miningData.production_total_au_eq_koz) {
        const prodMatch = text.match(/production\s*:\s*(\d+(\.\d+)?)\s*(?:thousand\s+ounces|koz)\s*(?:au\s*eq|gold\s+equivalent)/i);
        if (prodMatch) miningData.production_total_au_eq_koz = parseFloat(prodMatch[1]);
      }
      if (!miningData.aisc_last_year_value) {
        const aiscMatch = text.match(/aisc\s*:\s*\$(\d+(\.\d+)?)\s*(?:per\s+ounce|\/oz)/i);
        if (aiscMatch) miningData.aisc_last_year_value = parseFloat(aiscMatch[1]);
      }
      console.log(`[${new Date().toISOString()}] Extracted from MiningFeeds: Production=${miningData.production_total_au_eq_koz} koz AuEq, AISC=${miningData.aisc_last_year_value} USD/oz`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] MiningFeeds news search failed for ${ticker}: ${e.message}`);
      await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] MiningFeeds failed for ${ticker}: ${e.message}\n`);
    }
  }

  await browser.close();
  return miningData;
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
  console.log(`[${new Date().toISOString()}] Starting mining data population for ${TICKERS.length} tickers`);
  for (const ticker of TICKERS) {
    console.log(`[${new Date().toISOString()}] Beginning deep search for ${ticker}`);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const data = await deepSearchTicker(ticker);
        await updateJsonFile(ticker, data);
        console.log(`[${new Date().toISOString()}] Successfully processed ${ticker}`);
        break;
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
        if (attempt < MAX_RETRIES - 1) await delay(DELAY_BETWEEN_REQUESTS, `Retrying deep search for ${ticker}`);
        else {
          console.error(`[${new Date().toISOString()}] All retries exhausted for ${ticker}`);
          await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${ticker} failed after ${MAX_RETRIES} attempts: ${e.message}\n`);
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
