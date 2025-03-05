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
yahooFinance.suppressNotices(['yahooSurvey']);

const CSV_FILE = 'public/data/companies.csv';
const PDF_DIR = 'public/data/PDFs/';
const LOG_FILE = 'mining_population_log.txt';
const ALPHA_VANTAGE_KEY = 'BIV80TT696VJIUL2';
const MAX_RETRIES = 3;
const BASE_DELAY = 30000;
const TIMEOUT = 60000;
const STOCK_PRICE_VARIANCE_THRESHOLD = 0.05;

const db = new sqlite3.Database('./mining_companies.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to database for mining population.');
});

async function delay(ms, message = 'Delaying') {
    const randomDelay = ms + Math.floor(Math.random() * 10000);
    const logMessage = `[${new Date().toISOString()}] ${message} for ${randomDelay / 1000}s`;
    console.log(logMessage);
    await fs.appendFile(LOG_FILE, logMessage + '\n');
    return new Promise(resolve => setTimeout(resolve, randomDelay));
}

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
                await delay(BASE_DELAY, `Retrying ${source} fetch for ${ticker}`);
            } else {
                throw new Error(`Failed to load ${source} URL ${url} after ${retries} attempts`);
            }
        }
    }
}

async function getCompanyUrls(ticker) {
    return new Promise((resolve, reject) => {
        db.all('SELECT url_type, url FROM company_urls WHERE tsx_code = ?', [ticker], (err, rows) => {
            if (err) {
                console.error(`Error fetching URLs for ${ticker}: ${err.message}`);
                reject(err);
            } else {
                resolve(rows.reduce((acc, row) => {
                    acc[row.url_type] = row.url;
                    return acc;
                }, {}));
            }
        });
    });
}

async function validateUrl(url) {
    if (!url) return false;
    try {
        const response = await axios.get(url, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36' }
        });
        return response.status === 200;
    } catch (error) {
        console.warn(`URL validation failed for ${url}: ${error.message}`);
        return false;
    }
}

async function fetchHomepageData(ticker, url) {
    if (!url || !(await validateUrl(url))) {
        await db.run(
            "INSERT INTO url_verification_log (company_ticker, url_type, attempted_url, status) VALUES (?, ?, ?, ?)",
            [ticker, "homepage", url || "none", "invalid"]
        );
        return null;
    }

    try {
        const response = await axios.get(url, { timeout: 10000 });
        const $ = cheerio.load(response.data);
        const text = $('body').text().replace(/\s+/g, ' ').trim();

        const goldMozMatch = text.match(/indicated mineral resources.*?(\d+\.?\d*)\s*Moz\s*AuEq/i);
        const silverMozMatch = text.match(/silver.*?(\d+\.?\d*)\s*Moz/i);

        if (goldMozMatch) {
            return {
                resources_gold_moz_from_homepage: parseFloat(goldMozMatch[1]),
                resources_silver_moz_from_homepage: silverMozMatch ? parseFloat(silverMozMatch[1]) : 0,
                last_updated_homepage: new Date().toISOString(),
                source: url
            };
        }
    } catch (err) {
        console.warn(`Failed to fetch homepage data from ${url} for ${ticker}: ${err.message}`);
        await db.run(
            "INSERT INTO url_verification_log (company_ticker, url_type, attempted_url, status) VALUES (?, ?, ?, ?)",
            [ticker, "homepage", url, "fetch failed"]
        );
    }
    return null;
}

async function extractPdfData(ticker, pdfPath) {
    try {
        const dataBuffer = await fs.readFile(pdfPath);
        const pdfData = await pdf(dataBuffer);
        const text = pdfData.text;

        const resourcePatterns = [
            /(?:measured\s+and\s+)?indicated\s+resources\s*[:=]\s*(\d+(?:\.\d+)?)\s*(million\s+ounces|moz)\s*(?:gold|au)/i,
            /inferred\s+resources\s*[:=]\s*(\d+(?:\.\d+)?)\s*(moz|million\s+ounces)/i,
            /gold\s+resources\s*[:=]\s*(\d+(?:\.\d+)?)\s*(moz|million\s+ounces)/i
        ];
        const reservePatterns = [
            /measured\s+(?:and\s+indicated\s+)?reserves\s*[:=]\s*(\d+(?:\.\d+)?)\s*(million\s+ounces|moz)\s*(?:gold|au)/i,
            /proven\s+(?:and\s+probable\s+)?reserves\s*[:=]\s*(\d+(?:\.\d+)?)\s*(moz|million\s+ounces)/i
        ];
        const productionPatterns = [
            /(?:annual\s+)?production\s*[:=]\s*(\d+(?:\.\d+)?)\s*(?:thousand\s+ounces|koz)\s*(?:gold\s+equivalent|au\s*eq)/i
        ];
        const aiscPatterns = [
            /aisc\s*[:=]\s*\$?(\d+(?:\.\d+)?)\s*(?:per\s+ounce|\/oz|\$)/i
        ];

        let reserves_gold_moz = 0;
        let resources_gold_moz = 0;
        let production_total_au_eq_koz = 0;
        let aisc_last_year_value = 0;

        for (const pattern of reservePatterns) {
            const match = text.match(pattern);
            if (match) reserves_gold_moz = parseFloat(match[1]);
        }
        for (const pattern of resourcePatterns) {
            const match = text.match(pattern);
            if (match) resources_gold_moz += parseFloat(match[1]);
        }
        for (const pattern of productionPatterns) {
            const match = text.match(pattern);
            if (match) production_total_au_eq_koz = parseFloat(match[1]);
        }
        for (const pattern of aiscPatterns) {
            const match = text.match(pattern);
            if (match) aisc_last_year_value = parseFloat(match[1]);
        }

        return {
            reserves_gold_moz,
            resources_gold_moz,
            production_total_au_eq_koz,
            aisc_last_year_value,
            source: pdfPath
        };
    } catch (e) {
        console.error(`Error processing PDF ${pdfPath} for ${ticker}: ${e.message}`);
        await db.run(
            "INSERT INTO url_verification_log (company_ticker, url_type, attempted_url, status) VALUES (?, ?, ?, ?)",
            [ticker, "pdf_report", pdfPath, "processing failed"]
        );
        return null;
    }
}

async function fetchYahooFinanceStockPrice(ticker, url) {
    try {
        // Use yahoo-finance2 for consistency with populate_company_urls.js and populate_financials.js
        const quote = await yahooFinance.quoteSummary(ticker, { modules: ['price'] });
        if (quote.price && quote.price.regularMarketPrice) {
            return {
                stock_price: quote.price.regularMarketPrice,
                source: 'Yahoo Finance API'
            };
        }
        console.warn(`No stock price data found for ${ticker} on Yahoo Finance`);
        return null;
    } catch (err) {
        console.warn(`Failed to fetch Yahoo Finance data for ${ticker}: ${err.message}`);
        await db.run(
            "INSERT INTO url_verification_log (company_ticker, url_type, attempted_url, status) VALUES (?, ?, ?, ?)",
            [ticker, "yahoo_finance", url, err.message]
        );
        return null;
    }
}

async function fetchAlphaVantageStockPrice(ticker) {
    const baseUrl = 'https://www.alphavantage.co/query';
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await axios.get(`${baseUrl}?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`);
            const quoteData = response.data["Global Quote"];
            if (quoteData && quoteData["05. price"]) {
                return {
                    stock_price: parseFloat(quoteData["05. price"]),
                    source: `Alpha Vantage API (GLOBAL_QUOTE)`
                };
            }
            return null;
        } catch (e) {
            console.error(`Alpha Vantage fetch attempt ${attempt + 1} failed for ${ticker}: ${e.message}`);
            if (attempt < MAX_RETRIES - 1) await delay(5000 * Math.pow(2, attempt));
        }
    }
    console.error(`Alpha Vantage fetch exhausted retries for ${ticker}`);
    return null;
}

async function crossVerifyData(ticker, homepageData, pdfData, yahooData, alphaData) {
    const sources = [];
    const verifiedData = {
        reserves_gold_moz: pdfData?.reserves_gold_moz || 0,
        resources_gold_moz: homepageData?.resources_gold_moz_from_homepage || pdfData?.resources_gold_moz || 0,
        resources_silver_moz_from_homepage: homepageData?.resources_silver_moz_from_homepage || 0,
        production_total_au_eq_koz: pdfData?.production_total_au_eq_koz || 0,
        aisc_last_year_value: pdfData?.aisc_last_year_value || 0,
        stock_price: 0
    };

    // Cross-verify stock price
    const stockPrices = [];
    if (yahooData?.stock_price) stockPrices.push({ source: 'Yahoo Finance', value: yahooData.stock_price });
    if (alphaData?.stock_price) stockPrices.push({ source: 'Alpha Vantage', value: alphaData.stock_price });

    if (stockPrices.length === 0) {
        console.warn(`No stock price data available for ${ticker}`);
        verifiedData.stock_price = 0;
    } else if (stockPrices.length === 1) {
        verifiedData.stock_price = stockPrices[0].value;
        sources.push(stockPrices[0].source);
    } else {
        const values = stockPrices.map(s => s.value);
        const variance = Math.max(...values) - Math.min(...values);
        const avgPrice = values.reduce((sum, val) => sum + val, 0) / values.length;
        if (variance / avgPrice > STOCK_PRICE_VARIANCE_THRESHOLD) {
            console.warn(`Stock price variance for ${ticker}: ${stockPrices.map(s => `${s.source}=${s.value}`).join(', ')}, Variance=${variance.toFixed(2)}`);
            verifiedData.stock_price = stockPrices.find(s => s.source === 'Yahoo Finance')?.value || values[0];
        } else {
            verifiedData.stock_price = avgPrice;
        }
        sources.push(...stockPrices.map(s => s.source));
    }

    if (homepageData) sources.push(homepageData.source);
    if (pdfData) sources.push(pdfData.source);

    if (homepageData?.resources_gold_moz_from_homepage && pdfData?.resources_gold_moz) {
        const variance = Math.abs(homepageData.resources_gold_moz_from_homepage - pdfData.resources_gold_moz);
        if (variance > 0.1) {
            console.warn(`Resource variance for ${ticker}: Homepage=${homepageData.resources_gold_moz_from_homepage}, PDF=${pdfData.resources_gold_moz}, Variance=${variance}`);
            await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Resource variance for ${ticker}: Homepage=${homepageData.resources_gold_moz_from_homepage}, PDF=${pdfData.resources_gold_moz}, Variance=${variance}\n`);
        }
    }

    return { verifiedData, sources };
}

async function updateDatabase(ticker, data) {
    // Ensure data.verifiedData exists
    if (!data || !data.verifiedData) {
        console.error(`Invalid data for ${ticker}:`, data);
        throw new Error(`Cannot update database for ${ticker}: verifiedData is missing`);
    }

    const fields = [
        'reserves_gold_moz',
        'resources_gold_moz',
        'resources_gold_moz_from_homepage',
        'resources_silver_moz_from_homepage',
        'production_total_au_eq_koz',
        'aisc_last_year_value',
        'stock_price',
        'last_updated_mining',
        'last_updated_homepage',
        'company_website',
        'pdf_sources',
        'sources'
    ];
    const updateFields = fields.map(field => `${field} = ?`).join(', ');
    const values = [
        data.verifiedData.reserves_gold_moz || 0,
        data.verifiedData.resources_gold_moz || 0,
        data.verifiedData.resources_gold_moz_from_homepage || 0,
        data.verifiedData.resources_silver_moz_from_homepage || 0,
        data.verifiedData.production_total_au_eq_koz || 0,
        data.verifiedData.aisc_last_year_value || 0,
        data.verifiedData.stock_price || 0,
        new Date().toISOString(),
        data.verifiedData.last_updated_homepage || null,
        data.company_website || '',
        JSON.stringify(data.pdf_sources || []),
        JSON.stringify(data.sources || [])
    ];
    values.push(ticker);

    const sql = `UPDATE companies SET ${updateFields} WHERE tsx_code = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, values, function(err) {
            if (err) {
                console.error(`Error updating ${ticker}: ${err.message}`);
                reject(err);
            } else {
                console.log(`Updated mining data for ${ticker} in database`);
                resolve();
            }
        });
    });
}

async function main() {
    try {
        const csvData = await fs.readFile(CSV_FILE, 'utf8');
        const cleanedCsvData = csvData.trim().replace(/^\ufeff/, '');
        const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });
        console.log(`Parsed ${companies.length} companies from CSV:`);
        console.log(companies.map(c => c.TICKER).join(', '));

        for (const { TICKER: ticker, NAME: name } of companies) {
            if (!ticker || ticker === 'undefined') {
                console.error(`Invalid ticker found: ${JSON.stringify({ TICKER: ticker, NAME: name })}`);
                await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Skipping invalid ticker: ${JSON.stringify({ TICKER: ticker, NAME: name })}\n`);
                continue;
            }
            console.log(`Processing ${ticker} (${name})`);

            const urls = await getCompanyUrls(ticker);
            const homepageUrl = urls.homepage;
            const pdfUrl = urls.pdf_report;
            const yahooFinanceUrl = urls.yahoo_finance;

            let miningData = {
                reserves_gold_moz: 0,
                resources_gold_moz: 0,
                resources_gold_moz_from_homepage: 0,
                resources_silver_moz_from_homepage: 0,
                production_total_au_eq_koz: 0,
                aisc_last_year_value: 0,
                stock_price: 0,
                last_updated_homepage: null,
                company_website: homepageUrl || '',
                pdf_sources: [],
                sources: []
            };

            const homepageData = await fetchHomepageData(ticker, homepageUrl);
            if (homepageData) {
                miningData.resources_gold_moz_from_homepage = homepageData.resources_gold_moz_from_homepage;
                miningData.resources_silver_moz_from_homepage = homepageData.resources_silver_moz_from_homepage;
                miningData.last_updated_homepage = homepageData.last_updated_homepage;
            }

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

            const yahooData = await fetchYahooFinanceStockPrice(ticker, yahooFinanceUrl);
            const alphaData = await fetchAlphaVantageStockPrice(ticker);

            const { verifiedData, sources } = await crossVerifyData(ticker, homepageData, pdfData, yahooData, alphaData);
            miningData = { ...miningData, verifiedData, sources };

            await updateDatabase(ticker, miningData);
            await delay(BASE_DELAY, `Pausing after processing ${ticker}`);
        }
    } catch (err) {
        console.error('Main failed:', err);
        await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Main failed: ${err.message}\n`);
    } finally {
        db.close();
    }
}

main();