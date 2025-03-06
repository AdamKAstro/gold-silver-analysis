// Import required libraries
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

// Configuration constants
const CSV_FILE = 'public/data/companies.csv';           // Path to companies CSV file
const PDF_DIR = 'public/data/PDFs/';                    // Directory for PDF files
const LOG_FILE = 'mining_population_log.txt';           // Log file for diagnostics
const ALPHA_VANTAGE_KEY = 'BIV80TT696VJIUL2';           // Alpha Vantage API key (replace with your own)
const MAX_RETRIES = 3;                                  // Max retries for failed requests
const BASE_DELAY = 30000;                               // Base delay between company processing (ms)
const TIMEOUT = 60000;                                  // Timeout for network requests (ms)
const STOCK_PRICE_VARIANCE_THRESHOLD = 0.05;            // 5% variance threshold for stock prices

// Initialize SQLite database connection
const db = new sqlite3.Database('./mining_companies.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to SQLite database for mining data population.');
});

/**
 * Delays execution with a random jitter to avoid rate limiting
 * @param {number} ms - Base delay in milliseconds
 * @param {string} message - Message to log
 * @returns {Promise<void>}
 */
async function delay(ms, message = 'Delaying') {
    const randomDelay = ms + Math.floor(Math.random() * 10000); // Add up to 10s jitter
    const logMessage = `[${new Date().toISOString()}] ${message} for ${randomDelay / 1000}s`;
    console.log(logMessage);
    await fs.appendFile(LOG_FILE, logMessage + '\n');
    return new Promise(resolve => setTimeout(resolve, randomDelay));
}

/**
 * Fetches URLs associated with a company ticker from the database
 * @param {string} ticker - Company ticker symbol
 * @returns {Promise<Object>} - Object mapping URL types to URLs
 */
async function getCompanyUrls(ticker) {
    return new Promise((resolve, reject) => {
        db.all('SELECT url_type, url FROM company_urls WHERE tsx_code = ?', [ticker], (err, rows) => {
            if (err) {
                console.error(`Error fetching URLs for ${ticker}: ${err.message}`);
                reject(err);
            } else {
                const urls = rows.reduce((acc, row) => {
                    acc[row.url_type] = row.url;
                    return acc;
                }, {});
                console.log(`Fetched URLs for ${ticker}: ${JSON.stringify(urls)}`);
                resolve(urls);
            }
        });
    });
}

/**
 * Validates a URL by checking its HTTP status
 * @param {string} url - URL to validate
 * @returns {Promise<boolean>} - True if valid, false otherwise
 */
async function validateUrl(url) {
    if (!url) return false;
    try {
        const response = await axios.head(url, { timeout: 5000 });
        const isValid = response.status === 200;
        console.log(`Validated URL ${url}: ${isValid ? 'Valid' : 'Invalid'}`);
        return isValid;
    } catch (error) {
        console.warn(`URL validation failed for ${url}: ${error.message}`);
        return false;
    }
}

/**
 * Extracts numbers with contextual keywords from text
 * @param {string} text - Text to analyze
 * @returns {Array<Object>} - Array of matches with number, unit, and context
 */
function extractNumbersWithContext(text) {
    const numberRegex = /(\d{1,3}(,\d{3})*(\.\d+)?|\d+\.\d+|\d+)\s*(moz|million ounces|koz|thousand ounces)/gi;
    const matches = [];
    let match;
    while ((match = numberRegex.exec(text)) !== null) {
        const start = Math.max(0, match.index - 50);
        const end = Math.min(text.length, match.index + match[0].length + 50);
        const context = text.slice(start, end).toLowerCase();
        matches.push({
            number: parseFloat(match[1].replace(/,/g, '')),
            unit: match[4].toLowerCase(),
            context
        });
    }
    return matches;
}

/**
 * Classifies a match based on context keywords
 * @param {Object} match - Match object with number, unit, and context
 * @returns {Object|null} - Classified key-value pair or null
 */
function classifyMatch(match) {
    const keywords = {
        gold: /gold|au/i.test(match.context),
        silver: /silver|ag/i.test(match.context),
        resources: /resources|indicated|inferred/i.test(match.context),
        reserves: /reserves|proven|probable/i.test(match.context),
        production: /production|produced/i.test(match.context),
        aisc: /aisc|all-in sustaining cost/i.test(match.context)
    };

    if (match.unit.includes('moz')) {
        if (keywords.gold && keywords.resources) return { key: 'resources_gold_moz', value: match.number };
        if (keywords.silver && keywords.resources) return { key: 'resources_silver_moz', value: match.number };
        if (keywords.gold && keywords.reserves) return { key: 'reserves_gold_moz', value: match.number };
        if (keywords.silver && keywords.reserves) return { key: 'reserves_silver_moz', value: match.number };
    } else if (match.unit.includes('koz')) {
        if (keywords.gold && keywords.production) return { key: 'production_total_au_eq_koz', value: match.number };
    } else if (keywords.aisc) {
        return { key: 'aisc_last_year_value', value: match.number };
    }
    return null;
}

/**
 * Fetches overview data from a company webpage
 * @param {string} ticker - Company ticker
 * @param {string} url - URL to fetch
 * @returns {Promise<Object|null>} - Extracted data or null
 */
async function fetchOverviewData(ticker, url) {
    if (!url || !(await validateUrl(url))) {
        console.log(`Invalid or missing overview URL for ${ticker}: ${url || 'none'}`);
        return null;
    }

    try {
        const response = await axios.get(url, { timeout: 5000 });
        const $ = cheerio.load(response.data);
        const text = $('body').text().replace(/\s+/g, ' ').trim();

        const matches = extractNumbersWithContext(text);
        const data = { source: url, last_updated_overview: new Date().toISOString() };
        for (const match of matches) {
            const classification = classifyMatch(match);
            if (classification && !data[classification.key]) {
                data[classification.key] = classification.value;
            }
        }

        if (Object.keys(data).length > 2) { // More than just source and timestamp
            console.log(`Extracted overview data for ${ticker}: ${JSON.stringify(data)}`);
            return data;
        }
        console.log(`No significant overview data found for ${ticker} at ${url}`);
        return null;
    } catch (err) {
        console.warn(`Failed to fetch overview data for ${ticker} from ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Extracts data from a PDF file
 * @param {string} ticker - Company ticker
 * @param {string} pdfPath - Path to PDF file
 * @returns {Promise<Object|null>} - Extracted data or null
 */
async function extractPdfData(ticker, pdfPath) {
    try {
        const dataBuffer = await fs.readFile(pdfPath);
        const pdfData = await pdf(dataBuffer);
        const text = pdfData.text;

        const matches = extractNumbersWithContext(text);
        const data = { source: pdfPath };
        for (const match of matches) {
            const classification = classifyMatch(match);
            if (classification && !data[classification.key]) {
                data[classification.key] = classification.value;
            }
        }

        if (Object.keys(data).length > 1) { // More than just source
            console.log(`Extracted PDF data for ${ticker} from ${pdfPath}: ${JSON.stringify(data)}`);
            return data;
        }
        console.log(`No significant data extracted from PDF for ${ticker} at ${pdfPath}`);
        return null;
    } catch (e) {
        console.warn(`PDF extraction failed for ${ticker} from ${pdfPath}: ${e.message}`);
        return null;
    }
}

/**
 * Fetches stock price from Yahoo Finance using Axios and Cheerio
 * @param {string} ticker - Company ticker
 * @param {string} url - Yahoo Finance URL
 * @returns {Promise<Object|null>} - Stock price data or null
 */
async function fetchYahooFinanceStockPrice(ticker, url) {
    if (!url || !(await validateUrl(url))) {
        console.log(`Invalid or missing Yahoo Finance URL for ${ticker}: ${url || 'none'}`);
        return null;
    }

    try {
        const response = await axios.get(url, { timeout: 5000 });
        const $ = cheerio.load(response.data);
        const text = $('body').text().replace(/\s+/g, ' ').trim();

        const stockPriceMatch = text.match(/Current Price.*?\d+\.\d+/i);
        const stockPrice = stockPriceMatch ? parseFloat(stockPriceMatch[0].match(/\d+\.\d+/)[0]) : 0;

        if (stockPrice > 0) {
            console.log(`Fetched Yahoo Finance stock price for ${ticker}: ${stockPrice}`);
            return { stock_price: stockPrice, source: url };
        }
        console.log(`No stock price found on Yahoo Finance for ${ticker}`);
        return null;
    } catch (err) {
        console.warn(`Failed to fetch Yahoo Finance data for ${ticker} from ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Fetches stock price from Alpha Vantage API with retry logic
 * @param {string} ticker - Company ticker
 * @returns {Promise<Object|null>} - Stock price data or null
 */
async function fetchAlphaVantageStockPrice(ticker) {
    const baseUrl = 'https://www.alphavantage.co/query';
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await axios.get(`${baseUrl}?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`);
            const quoteData = response.data["Global Quote"];
            if (quoteData && quoteData["05. price"]) {
                const stockPrice = parseFloat(quoteData["05. price"]);
                console.log(`Fetched Alpha Vantage stock price for ${ticker}: ${stockPrice}`);
                return { stock_price: stockPrice, source: 'Alpha Vantage API (GLOBAL_QUOTE)' };
            }
            console.log(`No stock price data from Alpha Vantage for ${ticker}`);
            return null;
        } catch (e) {
            console.error(`Alpha Vantage fetch attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
            if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt), `Retrying Alpha Vantage for ${ticker}`);
        }
    }
    console.error(`Alpha Vantage fetch exhausted retries for ${ticker}`);
    return null;
}

/**
 * Cross-verifies data from multiple sources, prioritizing PDFs for certain fields
 * @param {string} ticker - Company ticker
 * @param {Object|null} overviewData - Data from overview page
 * @param {Object|null} pdfData - Data from PDF
 * @param {Object|null} yahooData - Data from Yahoo Finance
 * @param {Object|null} alphaData - Data from Alpha Vantage
 * @returns {Promise<Object>} - Verified data and sources
 */
async function crossVerifyData(ticker, overviewData, pdfData, yahooData, alphaData) {
    const sources = [];
    const verifiedData = {
        reserves_gold_moz: pdfData?.reserves_gold_moz || 0,
        resources_gold_moz: pdfData?.resources_gold_moz || overviewData?.resources_gold_moz || 0,
        resources_silver_moz: pdfData?.resources_silver_moz || overviewData?.resources_silver_moz || 0,
        production_total_au_eq_koz: pdfData?.production_total_au_eq_koz || 0,
        aisc_last_year_value: pdfData?.aisc_last_year_value || 0,
        stock_price: 0
    };

    // Cross-verify stock price
    const stockPrices = [];
    if (yahooData?.stock_price) stockPrices.push({ source: 'Yahoo Finance', value: yahooData.stock_price });
    if (alphaData?.stock_price) stockPrices.push({ source: 'Alpha Vantage', value: alphaData.stock_price });

    if (stockPrices.length === 0) {
        verifiedData.stock_price = 0;
        console.warn(`No stock price data available for ${ticker}`);
    } else if (stockPrices.length === 1) {
        verifiedData.stock_price = stockPrices[0].value;
        sources.push(stockPrices[0].source);
    } else {
        const values = stockPrices.map(s => s.value);
        const variance = Math.max(...values) - Math.min(...values);
        const avgPrice = values.reduce((sum, val) => sum + val, 0) / values.length;
        if (variance / avgPrice > STOCK_PRICE_VARIANCE_THRESHOLD) {
            console.warn(`Stock price variance for ${ticker}: ${stockPrices.map(s => `${s.source}=${s.value}`).join(', ')}, Variance=${variance.toFixed(2)}`);
            verifiedData.stock_price = stockPrices.find(s => s.source === 'Yahoo Finance')?.value || values[0]; // Prefer Yahoo if high variance
        } else {
            verifiedData.stock_price = avgPrice;
        }
        sources.push(...stockPrices.map(s => s.source));
    }

    // Log sources
    if (overviewData) sources.push(overviewData.source);
    if (pdfData) sources.push(pdfData.source);
    console.log(`Cross-verified data sources for ${ticker}: ${sources.join(', ')}`);

    return { verifiedData, sources };
}

/**
 * Updates the database with verified mining data
 * @param {string} ticker - Company ticker
 * @param {Object} data - Data to update
 * @returns {Promise<void>}
 */
async function updateDatabase(ticker, data) {
    const fields = [
        'reserves_gold_moz',
        'resources_gold_moz',
        'resources_silver_moz',
        'production_total_au_eq_koz',
        'aisc_last_year_value',
        'stock_price',
        'last_updated_mining',
        'last_updated_overview',
        'company_website',
        'pdf_sources',
        'sources'
    ];
    const updateFields = fields.map(field => `${field} = ?`).join(', ');
    const values = [
        data.verifiedData.reserves_gold_moz || 0,
        data.verifiedData.resources_gold_moz || 0,
        data.verifiedData.resources_silver_moz || 0,
        data.verifiedData.production_total_au_eq_koz || 0,
        data.verifiedData.aisc_last_year_value || 0,
        data.verifiedData.stock_price || 0,
        new Date().toISOString(),
        data.last_updated_overview || null,
        data.company_website || '',
        JSON.stringify(data.pdf_sources || []),
        JSON.stringify(data.sources || [])
    ];
    values.push(ticker);

    const sql = `UPDATE companies SET ${updateFields} WHERE tsx_code = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, values, function(err) {
            if (err) {
                console.error(`Error updating database for ${ticker}: ${err.message}`);
                reject(err);
            } else {
                console.log(`Successfully updated database for ${ticker} with data: ${JSON.stringify(data.verifiedData)}`);
                resolve();
            }
        });
    });
}

/**
 * Main function to orchestrate data collection and processing
 */
async function main() {
    try {
        // Read and parse CSV file
        const csvData = await fs.readFile(CSV_FILE, 'utf8');
        const cleanedCsvData = csvData.trim().replace(/^\ufeff/, ''); // Remove BOM if present
        const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });
        console.log(`Parsed ${companies.length} companies from CSV: ${companies.map(c => c.TICKER).join(', ')}`);

        for (const { TICKER: ticker, NAME: name } of companies) {
            if (!ticker || ticker === 'undefined') {
                console.error(`Invalid ticker found: ${JSON.stringify({ TICKER: ticker, NAME: name })}`);
                await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Skipping invalid ticker: ${ticker}\n`);
                continue;
            }
            console.log(`\n=== Processing ${ticker} (${name}) ===`);

            // Fetch URLs from database
            const urls = await getCompanyUrls(ticker);
            const overviewUrl = urls.overview || urls.homepage || `https://www.${ticker.replace('.', '').toLowerCase()}.com`;
            const pdfUrl = urls.pdf_report;
            const yahooFinanceUrl = urls.yahoo_finance || `https://finance.yahoo.com/quote/${ticker}/`;

            // Initialize data object
            let miningData = {
                reserves_gold_moz: 0,
                resources_gold_moz: 0,
                resources_silver_moz: 0,
                production_total_au_eq_koz: 0,
                aisc_last_year_value: 0,
                stock_price: 0,
                last_updated_overview: null,
                company_website: overviewUrl || '',
                pdf_sources: [],
                sources: []
            };

            // Fetch overview data
            const overviewData = await fetchOverviewData(ticker, overviewUrl);
            if (overviewData) {
                miningData.resources_gold_moz = overviewData.resources_gold_moz || 0;
                miningData.resources_silver_moz = overviewData.resources_silver_moz || 0;
                miningData.last_updated_overview = overviewData.last_updated_overview;
            }

            // Process PDFs
            let pdfData = null;
            const pdfFiles = (await fs.readdir(PDF_DIR)).filter(file => file.startsWith(ticker) && file.endsWith('.pdf'));
            for (const pdfFile of pdfFiles) {
                const pdfPath = path.join(PDF_DIR, pdfFile);
                const data = await extractPdfData(ticker, pdfPath);
                if (data) {
                    pdfData = data;
                    miningData.pdf_sources.push(pdfPath);
                }
            }

            // Fetch stock prices
            const yahooData = await fetchYahooFinanceStockPrice(ticker, yahooFinanceUrl);
            const alphaData = await fetchAlphaVantageStockPrice(ticker);

            // Cross-verify and combine data
            const { verifiedData, sources } = await crossVerifyData(ticker, overviewData, pdfData, yahooData, alphaData);
            miningData = { ...miningData, ...verifiedData, sources };

            // Update database
            await updateDatabase(ticker, miningData);

            // Delay before next company to avoid rate limiting
            await delay(BASE_DELAY, `Pausing after processing ${ticker}`);
        }
    } catch (err) {
        console.error('Main execution failed:', err);
        await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Main failed: ${err.message}\n`);
    } finally {
        db.close(() => console.log('Database connection closed.'));
    }
}

// Execute the main function
main();