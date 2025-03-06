const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3').verbose();
const pdf = require('pdf-parse');
const yahooFinance = require('yahoo-finance2').default;
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
yahooFinance.suppressNotices(['yahooSurvey']);

// Configuration
const CSV_FILE = 'public/data/companies.csv';
const PDF_DIR = 'public/data/PDFs/';
const LOG_FILE = 'mining_population_log.txt';
const DB_PATH = './mining_companies.db';
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || 'BIV80TT696VJIUL2';
const MAX_RETRIES = 3;
const BASE_DELAY = 60000; // 60s to avoid rate limits
const TIMEOUT = 60000;

// Database setup
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error(`[ERROR] Database connection failed: ${err.message}`);
        process.exit(1);
    }
    console.log('[INFO] Connected to database.');
});

// Utility: Delay with logging
async function delay(ms, message = 'Delaying') {
    const randomDelay = ms + Math.floor(Math.random() * 10000);
    const logMessage = `[${new Date().toISOString()}] ${message} (${randomDelay / 1000}s)`;
    console.log(logMessage);
    await fs.appendFile(LOG_FILE, logMessage + '\n');
    return new Promise(resolve => setTimeout(resolve, randomDelay));
}

// Utility: Fetch with retry
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES, ticker, source) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(url, { timeout: TIMEOUT, ...options });
            console.log(`[INFO] Fetched ${source} URL ${url} for ${ticker}: Status ${response.status}`);
            return response;
        } catch (e) {
            console.warn(`[WARN] Attempt ${i + 1}/${retries} failed for ${source} ${url} (${ticker}): ${e.message}`);
            if (i < retries - 1) await delay(BASE_DELAY, `Retrying ${source} fetch for ${ticker}`);
            else throw e;
        }
    }
}

// Fetch URLs from company_urls with validation
async function getCompanyUrls(ticker) {
    return new Promise((resolve) => {
        db.all('SELECT url_type, url, last_checked FROM company_urls WHERE tsx_code = ?', [ticker], async (err, rows) => {
            if (err) {
                console.error(`[ERROR] Fetching URLs for ${ticker}: ${err.message}`);
                resolve({});
                return;
            }
            const urls = rows.reduce((acc, row) => {
                acc[row.url_type] = { url: row.url, last_checked: row.last_checked };
                return acc;
            }, {});
            console.log(`[INFO] Retrieved URLs for ${ticker} from DB: ${JSON.stringify(urls)}`);

            const validatedUrls = {};
            for (const [type, { url, last_checked }] of Object.entries(urls)) {
                if (await validateUrl(url)) {
                    validatedUrls[type] = url;
                    db.run('UPDATE company_urls SET last_checked = ? WHERE tsx_code = ? AND url_type = ?', 
                        [new Date().toISOString(), ticker, type]);
                } else {
                    console.warn(`[WARN] Invalid URL for ${ticker} (${type}): ${url}`);
                }
            }

            // Fallbacks
            if (!validatedUrls.yahoo_finance) {
                const yahooUrl = `https://finance.yahoo.com/quote/${ticker}/`;
                if (await validateUrl(yahooUrl)) validatedUrls.yahoo_finance = yahooUrl;
            }
            if (!validatedUrls.homepage) {
                const defaultHomepage = `https://www.${ticker.replace('.', '').toLowerCase()}.com`;
                if (await validateUrl(defaultHomepage)) validatedUrls.homepage = defaultHomepage;
            }

            resolve(validatedUrls);
        });
    });
}

// Validate URL
async function validateUrl(url) {
    if (!url) return false;
    try {
        await axios.head(url, { timeout: 10000 });
        console.log(`[INFO] Validated URL ${url}`);
        return true;
    } catch (error) {
        console.warn(`[WARN] URL validation failed for ${url}: ${error.message}`);
        return false;
    }
}

// Fetch homepage data
async function fetchHomepageData(ticker, urls) {
    const urlPriority = [urls.homepage, urls.jmn].filter(Boolean);
    for (const url of urlPriority) {
        try {
            const response = await fetchWithRetry(url, {}, MAX_RETRIES, ticker, 'homepage');
            const $ = cheerio.load(response.data);
            const text = $('body').text().replace(/\s+/g, ' ').trim();

            const patterns = [
                { key: 'resources_gold_moz_from_homepage', regex: /resources.*?gold.*?(\d+\.?\d*)\s*(?:moz|million ounces)/i },
                { key: 'resources_silver_moz_from_homepage', regex: /resources.*?silver.*?(\d+\.?\d*)\s*(?:moz|million ounces)/i }
            ];
            const data = { source: url, last_updated_homepage: new Date().toISOString() };
            for (const { key, regex } of patterns) {
                const match = text.match(regex);
                if (match) data[key] = parseFloat(match[1]);
            }

            if (Object.keys(data).length > 2) { // More than just source and timestamp
                console.log(`[INFO] Homepage data for ${ticker} from ${url}: ${JSON.stringify(data)}`);
                return data;
            }
        } catch (err) {
            console.warn(`[WARN] Homepage fetch failed for ${ticker} from ${url}: ${err.message}`);
        }
    }
    return null;
}

// Fetch and parse PDFs
async function fetchAndParsePdfs(ticker, urls) {
    let pdfFiles = (await fs.readdir(PDF_DIR)).filter(f => f.startsWith(ticker) && f.endsWith('.pdf'));
    if (pdfFiles.length === 0 && urls.homepage) {
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(urls.homepage, { waitUntil: 'networkidle0' });
        const pdfLinks = await page.$$eval('a[href$=".pdf"]', links => links.map(l => l.href));
        await browser.close();

        for (const pdfUrl of pdfLinks.slice(0, 3)) {
            const pdfPath = path.join(PDF_DIR, `${ticker}_${Date.now()}.pdf`);
            try {
                const response = await fetchWithRetry(pdfUrl, { responseType: 'arraybuffer' }, MAX_RETRIES, ticker, 'PDF');
                await fs.writeFile(pdfPath, response.data);
                pdfFiles.push(path.basename(pdfPath));
                console.log(`[INFO] Downloaded PDF for ${ticker}: ${pdfPath}`);
            } catch (err) {}
        }
    }

    for (const pdfFile of pdfFiles) {
        const pdfPath = path.join(PDF_DIR, pdfFile);
        const pdfData = await extractPdfData(ticker, pdfPath);
        if (pdfData) return { ...pdfData, pdf_source: pdfPath };
    }
    return null;
}

// PDF parsing
async function extractPdfData(ticker, pdfPath) {
    try {
        const dataBuffer = await fs.readFile(pdfPath);
        const pdfData = await pdf(dataBuffer);
        const text = pdfData.text;

        const patterns = [
            { key: 'reserves_gold_moz', regex: /reserves.*?gold.*?(\d+\.?\d*)\s*(?:moz|million ounces)/i },
            { key: 'resources_gold_moz', regex: /resources.*?gold.*?(\d+\.?\d*)\s*(?:moz|million ounces)/i },
            { key: 'production_total_au_eq_koz', regex: /production.*?(\d+\.?\d*)\s*(?:koz|thousand ounces)/i },
            { key: 'aisc_last_year_value', regex: /aisc.*?(\d+\.?\d*)\s*(?:\$|per ounce)/i }
        ];
        const data = { source: pdfPath };
        for (const { key, regex } of patterns) {
            const match = text.match(regex);
            if (match) data[key] = parseFloat(match[1]);
        }

        if (Object.keys(data).length > 1) {
            console.log(`[INFO] PDF data for ${ticker} from ${pdfPath}: ${JSON.stringify(data)}`);
            return data;
        }
        return null;
    } catch (e) {
        console.warn(`[WARN] PDF parsing failed for ${ticker} from ${pdfPath}: ${e.message}`);
        return null;
    }
}

// Fetch stock prices
async function fetchYahooFinanceStockPrice(ticker, urls) {
    const url = urls.yahoo_finance || `https://finance.yahoo.com/quote/${ticker}/`;
    if (await validateUrl(url)) {
        try {
            const quote = await yahooFinance.quoteSummary(ticker, { modules: ['price'] });
            if (quote.price && quote.price.regularMarketPrice) {
                console.log(`[INFO] Yahoo Finance stock price for ${ticker}: ${quote.price.regularMarketPrice}`);
                return { stock_price: quote.price.regularMarketPrice, source: url };
            }
        } catch (err) {
            console.warn(`[WARN] Yahoo Finance fetch failed for ${ticker}: ${err.message}`);
        }
    }
    return null;
}

async function fetchAlphaVantageStockPrice(ticker) {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`;
    try {
        const response = await fetchWithRetry(url, {}, MAX_RETRIES, ticker, 'Alpha Vantage');
        const price = response.data["Global Quote"]["05. price"];
        if (price) {
            console.log(`[INFO] Alpha Vantage stock price for ${ticker}: ${price}`);
            return { stock_price: parseFloat(price), source: url };
        }
    } catch (err) {
        console.warn(`[WARN] Alpha Vantage fetch failed for ${ticker}: ${err.message}`);
    }
    return null;
}

// Cross-verify data
async function crossVerifyData(ticker, homepageData, pdfData, yahooData, alphaData) {
    const sources = [];
    const verifiedData = {
        reserves_gold_moz: pdfData?.reserves_gold_moz || 0,
        resources_gold_moz: homepageData?.resources_gold_moz_from_homepage || pdfData?.resources_gold_moz || 0,
        resources_silver_moz_from_homepage: homepageData?.resources_silver_moz_from_homepage || 0,
        production_total_au_eq_koz: pdfData?.production_total_au_eq_koz || 0,
        aisc_last_year_value: pdfData?.aisc_last_year_value || 0,
        stock_price: yahooData?.stock_price || alphaData?.stock_price || 0
    };

    if (yahooData) sources.push(yahooData.source);
    if (alphaData) sources.push(alphaData.source);
    if (homepageData) sources.push(homepageData.source);
    if (pdfData) sources.push(pdfData.source);

    console.log(`[INFO] Verified data for ${ticker}: ${JSON.stringify(verifiedData)}`);
    return { verifiedData, sources };
}

// Update database
async function updateDatabase(ticker, data) {
    const { verifiedData, company_website, pdf_sources } = data;
    const sql = `
        UPDATE companies 
        SET reserves_gold_moz = ?, resources_gold_moz = ?, resources_silver_moz_from_homepage = ?, 
            production_total_au_eq_koz = ?, aisc_last_year_value = ?, stock_price = ?, 
            company_website = ?, pdf_sources = ?, sources = ?, last_updated_mining = ?, 
            last_updated_homepage = ?
        WHERE tsx_code = ?`;
    const values = [
        verifiedData.reserves_gold_moz, verifiedData.resources_gold_moz, verifiedData.resources_silver_moz_from_homepage,
        verifiedData.production_total_au_eq_koz, verifiedData.aisc_last_year_value, verifiedData.stock_price,
        company_website || '', JSON.stringify(pdf_sources || []), JSON.stringify(data.sources || []),
        new Date().toISOString(), verifiedData.last_updated_homepage || null, ticker
    ];

    return new Promise((resolve, reject) => {
        db.run(sql, values, (err) => {
            if (err) {
                console.error(`[ERROR] DB update failed for ${ticker}: ${err.message}`);
                reject(err);
            } else {
                console.log(`[INFO] Updated DB for ${ticker}`);
                resolve();
            }
        });
    });
}

// Main execution
async function main() {
    const argv = yargs(hideBin(process.argv))
        .option('update-stock-prices', { type: 'boolean', default: false })
        .option('update-mining-data', { type: 'boolean', default: false })
        .option('update-all', { type: 'boolean', default: true })
        .argv;

    try {
        console.log(`[INFO] Loading CSV from: ${path.resolve(CSV_FILE)}`);
        let csvData = await fs.readFile(CSV_FILE, 'utf8');
        console.log(`[DEBUG] Raw CSV data (first 500 chars): ${csvData.slice(0, 500)}`);

        // Remove BOM if present
        if (csvData.startsWith('\ufeff')) {
            csvData = csvData.slice(1);
            console.log('[INFO] Removed BOM from CSV data');
        }

        const companies = parse(csvData, { columns: true, skip_empty_lines: true, trim: true });
        console.log(`[DEBUG] Parsed companies (first 5): ${JSON.stringify(companies.slice(0, 5))}`);
        const tickers = companies.map(c => c.TICKER).filter(t => t && t !== 'undefined');
        console.log(`[INFO] Parsed ${tickers.length} valid tickers: ${tickers.slice(0, 5).join(', ')}...`);

        for (const company of companies) {
            const ticker = company.TICKER;
            if (!ticker) {
                console.warn(`[WARN] Skipping invalid ticker: ${JSON.stringify(company)}`);
                continue;
            }

            console.log(`[INFO] Processing ${ticker} (${company.NAME})`);
            const urls = await getCompanyUrls(ticker);
            const pdfData = await fetchAndParsePdfs(ticker, urls);
            const homepageData = await fetchHomepageData(ticker, urls);
            const yahooData = argv.updateStockPrices || argv.updateAll ? await fetchYahooFinanceStockPrice(ticker, urls) : null;
            const alphaData = argv.updateStockPrices || argv.updateAll ? await fetchAlphaVantageStockPrice(ticker) : null;

            const { verifiedData, sources } = await crossVerifyData(ticker, homepageData, pdfData, yahooData, alphaData);
            await updateDatabase(ticker, { 
                verifiedData, 
                company_website: urls.homepage || '', 
                pdf_sources: pdfData?.pdf_source ? [pdfData.pdf_source] : [] 
            });
            await delay(BASE_DELAY, `Pausing after ${ticker}`);
        }
    } catch (err) {
        console.error(`[ERROR] Main failed: ${err.message}`);
        await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Main failed: ${err.message}\n`);
    } finally {
        db.close((err) => {
            if (err) console.error(`[ERROR] Error closing database: ${err.message}`);
            else console.log('[INFO] Database connection closed.');
        });
    }
}

main();