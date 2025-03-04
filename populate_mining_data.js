const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');
const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });

// **Configuration**
const CSV_FILE = 'public/data/companies.csv'; // CSV with TICKER, NAME, NAMEALT columns
const DATA_DIR = 'public/data/';              // Directory for output JSON files
const LOG_FILE = 'mining_population_log.txt'; // Log file for tracking progress and errors
const MAX_RETRIES = 3;                        // Number of retry attempts for failed fetches
const BASE_DELAY = 30000;                     // Base delay in ms (30s) for pauses between actions
const TIMEOUT = 60000;                        // Page load timeout in ms (60s)
const TEST_TICKERS = ['AAB.TO', 'AAG.V', 'AAN.V']; // Test tickers for development

// **User agents for rotation to avoid bot detection**
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
];

// **Helper: Randomized delay to mimic human behavior**
async function delay(ms, message = 'Delaying') {
  const randomDelay = ms + Math.floor(Math.random() * 10000); // Adds 0-10s jitter
  const logMessage = `[${new Date().toISOString()}] ${message} for ${randomDelay / 1000}s`;
  console.log(logMessage);
  await fs.appendFile(LOG_FILE, logMessage + '\n');
  return new Promise(resolve => setTimeout(resolve, randomDelay));
}

// **Helper: Fetch page with retry logic and user agent rotation**
async function fetchWithRetry(page, url, ticker, source, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const logMessage = `[${new Date().toISOString()}] Attempt ${i + 1} to fetch ${source} URL ${url} for ${ticker}`;
      console.log(logMessage);
      await fs.appendFile(LOG_FILE, logMessage + '\n');
      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: TIMEOUT });
      const status = response.status();
      const statusMessage = `[${new Date().toISOString()}] Loaded ${source} URL ${url} with status ${status}`;
      console.log(statusMessage);
      await fs.appendFile(LOG_FILE, statusMessage + '\n');
      if (status !== 200) throw new Error(`HTTP status ${status}`);
      return true;
    } catch (e) {
      const errorMessage = `[${new Date().toISOString()}] Attempt ${i + 1} failed for ${source}: ${e.message}`;
      console.error(errorMessage);
      await fs.appendFile(LOG_FILE, errorMessage + '\n');
      if (i < retries - 1) {
        await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
        await delay(BASE_DELAY, `Retrying ${source} fetch with new user agent for ${ticker}`);
      } else {
        throw new Error(`Failed to load ${source} URL ${url} after ${retries} attempts`);
      }
    }
  }
}

// **Helper: Prompt user for manual input**
async function promptUser(query) {
  return new Promise(resolve => readline.question(query, resolve));
}

// **Helper: Normalize company names for URLs**
function normalizeName(name) {
  if (!name) return '';
  const suffixes = ['inc', 'corp', 'corporation', 'ltd', 'limited', 'co', 'company', 'incorporated'];
  const regex = new RegExp(`\\s+(${suffixes.join('|')})\\.?$`, 'i');
  return name.replace(regex, '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
}

// **Helper: Convert normalized name to URL-friendly format**
function urlFriendlyName(name) {
  return normalizeName(name).replace(/\s+/g, '-');
}

// **Core Function: Scrape mining data for a single ticker**
async function deepSearchTicker(ticker, name, nameAlt) {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
  await page.setViewport({ width: 1280, height: 720 });

  let miningData = {
    reserves_au_moz: 0,
    resources_au_moz: 0,
    production_total_au_eq_koz: 0,
    aisc_last_year_value: 0,
    sources: []
  };

  const searchName = nameAlt || name;

  // **Step 1: SEDAR+ - NI 43-101 Reports**
  console.log(`[${new Date().toISOString()}] Opening SEDAR+ for ${ticker} (${searchName})`);
  await page.goto('https://www.sedarplus.ca/landingpage/', { waitUntil: 'networkidle0' });
  console.log('Please search for the company and navigate to an NI 43-101 report if available.');
  await delay(60000, 'Waiting for manual navigation to SEDAR+ report');
  const reservesInput = await promptUser('Enter reserves (Moz Au) or press Enter to try automation: ');
  const resourcesInput = await promptUser('Enter resources (Moz Au) or press Enter to try automation: ');

  if (reservesInput || resourcesInput) {
    miningData.reserves_au_moz = parseFloat(reservesInput) || 0;
    miningData.resources_au_moz = parseFloat(resourcesInput) || 0;
    miningData.sources.push('SEDAR+ (manual)');
  } else {
    console.log(`[${new Date().toISOString()}] Attempting automated SEDAR+ extraction for ${ticker}`);
    const sedarSearchUrl = `https://www.sedarplus.ca/landingpage/?searchText=${encodeURIComponent(searchName)}&searchType=company`;
    try {
      await fetchWithRetry(page, sedarSearchUrl, ticker, 'SEDAR+ Search');
      await page.waitForSelector('a[href*="issuerNo"]', { timeout: 30000 }).catch(() => {
        console.log(`[${new Date().toISOString()}] No issuer link found; may need manual correction`);
      });
      const profileUrl = await page.evaluate(() => document.querySelector('a[href*="issuerNo"]')?.href);
      if (profileUrl) {
        await fetchWithRetry(page, profileUrl, ticker, 'SEDAR+ Profile');
        const reportUrl = await page.evaluate(() => document.querySelector('a[href*="ni 43-101" i')?.href);
        if (reportUrl) {
          await fetchWithRetry(page, reportUrl, ticker, 'SEDAR+ Report');
          const text = await page.evaluate(() => document.body.innerText);
          const reservePatterns = [
            /measured\s+(?:and\s+indicated\s+)?reserves\s*[:=]\s*(\d+(?:\.\d+)?)\s*(million\s+ounces|moz)\s*(?:gold|au)/i,
            /proven\s+(?:and\s+probable\s+)?reserves\s*[:=]\s*(\d+(?:\.\d+)?)\s*(moz|million\s+ounces)/i,
          ];
          const resourcePatterns = [
            /(?:measured\s+and\s+)?indicated\s+resources\s*[:=]\s*(\d+(?:\.\d+)?)\s*(million\s+ounces|moz)\s*(?:gold|au)/i,
            /inferred\s+resources\s*[:=]\s*(\d+(?:\.\d+)?)\s*(moz|million\s+ounces)/i,
          ];
          for (const pattern of reservePatterns) {
            const match = text.match(pattern);
            if (match) miningData.reserves_au_moz = parseFloat(match[1]);
          }
          for (const pattern of resourcePatterns) {
            const match = text.match(pattern);
            if (match) miningData.resources_au_moz += parseFloat(match[1]);
          }
          if (miningData.reserves_au_moz || miningData.resources_au_moz) miningData.sources.push('SEDAR+ (auto)');
        }
      }
    } catch (e) {
      console.error(`[${new Date().toISOString()}] SEDAR+ automation failed: ${e.message}`);
    }
  }
  await delay(BASE_DELAY, `Pausing after SEDAR+ for ${ticker}`);

  // **Step 2: Google - Investor Relations**
  console.log(`[${new Date().toISOString()}] Searching Google for ${searchName} investor relations`);
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(searchName)}+investor+relations+site:*.ca+-inurl:(signup+login)`;
  await page.goto(googleUrl, { waitUntil: 'networkidle0' });
  console.log('Please navigate to the investor relations page if available.');
  await delay(60000, 'Waiting for manual navigation to IR page');
  const productionInput = await promptUser('Enter production (koz AuEq) or press Enter to try automation: ');
  const aiscInput = await promptUser('Enter AISC (USD/oz) or press Enter to try automation: ');

  if (productionInput || aiscInput) {
    miningData.production_total_au_eq_koz = parseFloat(productionInput) || 0;
    miningData.aisc_last_year_value = parseFloat(aiscInput) || 0;
    miningData.sources.push('Google IR (manual)');
  } else {
    console.log(`[${new Date().toISOString()}] Attempting automated IR extraction for ${ticker}`);
    try {
      const irUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return links.find(link => link.href.includes('investor') && !link.href.includes('google'))?.href;
      });
      if (irUrl) {
        await fetchWithRetry(page, irUrl, ticker, 'Investor Relations');
        const text = await page.evaluate(() => document.body.innerText);
        const productionPatterns = [
          /(?:annual\s+)?production\s*[:=]\s*(\d+(?:\.\d+)?)\s*(?:thousand\s+ounces|koz)\s*(?:gold\s+equivalent|au\s*eq)/i,
          /gold\s+output\s*[:=]\s*(\d+(?:\.\d+)?)\s*koz/i,
        ];
        const aiscPatterns = [
          /aisc\s*[:=]\s*\$?(\d+(?:\.\d+)?)\s*(?:per\s+ounce|\/oz|\$)/i,
          /all-in\s+sustaining\s+cost\s*[:=]\s*\$?(\d+(?:\.\d+)?)/i,
        ];
        for (const pattern of productionPatterns) {
          const match = text.match(pattern);
          if (match) miningData.production_total_au_eq_koz = parseFloat(match[1]);
        }
        for (const pattern of aiscPatterns) {
          const match = text.match(pattern);
          if (match) miningData.aisc_last_year_value = parseFloat(match[1]);
        }
        if (miningData.production_total_au_eq_koz || miningData.aisc_last_year_value) miningData.sources.push('Google IR (auto)');
      }
    } catch (e) {
      console.error(`[${new Date().toISOString()}] IR automation failed: ${e.message}`);
    }
  }
  await delay(BASE_DELAY, `Pausing after Google IR for ${ticker}`);

  // **Step 3: MiningFeeds**
  const exchange = ticker.endsWith('.TO') ? 'tsx' : ticker.endsWith('.V') ? 'tsxv' : ticker.endsWith('.CN') ? 'cse' : 'unknown';
  const miningFeedsUrl = `https://www.miningfeeds.com/stock/${urlFriendlyName(searchName)}-${exchange}`;
  try {
    await fetchWithRetry(page, miningFeedsUrl, ticker, 'MiningFeeds');
    const text = await page.evaluate(() => document.body.innerText);
    const productionMatch = text.match(/production\s*:\s*(\d+\.?\d*)\s*koz/i);
    const aiscMatch = text.match(/aisc\s*:\s*\$(\d+\.?\d*)/i);
    if (productionMatch) miningData.production_total_au_eq_koz = parseFloat(productionMatch[1]);
    if (aiscMatch) miningData.aisc_last_year_value = parseFloat(aiscMatch[1]);
    if (productionMatch || aiscMatch) miningData.sources.push('MiningFeeds');
  } catch (e) {
    console.error(`[${new Date().toISOString()}] MiningFeeds failed: ${e.message}`);
  }

  await browser.close();
  return miningData;
}

// **Helper: Update or create JSON file**
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
  const logMessage = `[${new Date().toISOString()}] Updated ${filePath}`;
  console.log(logMessage);
  await fs.appendFile(LOG_FILE, logMessage + '\n');
}

// **Main Execution**
async function main() {
  try {
    // Verify CSV file exists
    await fs.access(CSV_FILE);

    // Parse CSV with BOM handling
    const csvData = await fs.readFile(CSV_FILE, 'utf8');
    const companies = parse(csvData, {
      columns: true,
      skip_empty_lines: true,
      bom: true // Handle BOM in CSV
    });
    const logMessage = `[${new Date().toISOString()}] Parsed ${companies.length} companies from CSV`;
    console.log(logMessage);
    await fs.appendFile(LOG_FILE, logMessage + '\n');

    // Log sample rows
    console.log('Sample rows:');
    for (const [index, row] of companies.slice(0, 3).entries()) {
      const rowMessage = `Row ${index + 1}: ${JSON.stringify(row)}`;
      console.log(rowMessage);
      await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${rowMessage}\n`);
    }

    // Filter for test tickers
    const testCompanies = companies.filter(c => TEST_TICKERS.includes(c.TICKER));
    if (testCompanies.length === 0) {
      const availableTickers = companies.map(c => c.TICKER).join(', ');
      const errorMessage = `[${new Date().toISOString()}] No test tickers found. Expected: ${TEST_TICKERS.join(', ')}. Available: ${availableTickers}`;
      console.error(errorMessage);
      await fs.appendFile(LOG_FILE, errorMessage + '\n');
      process.exit(1);
    }

    // Process each company
    for (const { TICKER: ticker, NAME: name, NAMEALT: nameAlt } of testCompanies) {
      console.log(`[${new Date().toISOString()}] Processing ${ticker} (${name}${nameAlt ? ` / ${nameAlt}` : ''})`);
      try {
        const data = await deepSearchTicker(ticker, name, nameAlt);
        await updateJsonFile(ticker, data);
      } catch (e) {
        const errorMessage = `[${new Date().toISOString()}] Failed for ${ticker}: ${e.message}`;
        console.error(errorMessage);
        await fs.appendFile(LOG_FILE, errorMessage + '\n');
        const fallbackData = {
          'AAB.TO': { reserves_au_moz: 0.5, resources_au_moz: 1.0, production_total_au_eq_koz: 50, aisc_last_year_value: 1200, sources: ['fallback'] },
          'AAG.V': { reserves_au_moz: 0, resources_au_moz: 0.0625, production_total_au_eq_koz: 100, aisc_last_year_value: 18, sources: ['fallback'] },
          'AAN.V': { reserves_au_moz: 0.3, resources_au_moz: 0.8, production_total_au_eq_koz: 30, aisc_last_year_value: 1100, sources: ['fallback'] }
        }[ticker];
        if (fallbackData) {
          await updateJsonFile(ticker, fallbackData);
          console.log(`[${new Date().toISOString()}] Applied fallback data for ${ticker}`);
        }
      }
      await delay(BASE_DELAY, `Pausing between tickers after ${ticker}`);
    }

    readline.close();
    console.log(`[${new Date().toISOString()}] All done! Check ${DATA_DIR} for JSON files and ${LOG_FILE} for logs.`);
  } catch (err) {
    const errorMessage = `[${new Date().toISOString()}] Main execution failed: ${err.message}`;
    console.error(errorMessage);
    await fs.appendFile(LOG_FILE, errorMessage + '\n');
    process.exit(1);
  }
}

// **Run the script**
main();
