const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3').verbose();
const yahooFinance = require('yahoo-finance2').default;
yahooFinance.suppressNotices(['yahooSurvey']);

const CSV_FILE = 'public/data/companies.csv';
const LOG_FILE = 'url_population_log.txt';
const ALPHA_VANTAGE_KEY = 'BIV80TT696VJIUL2';

const db = new sqlite3.Database('./mining_companies.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to database for URL population.');
});

// Helper: Add delay to avoid rate limits
async function delay(ms, message = 'Delaying') {
    const randomDelay = ms + Math.floor(Math.random() * 1000);
    const logMessage = `[${new Date().toISOString()}] ${message} for ${randomDelay / 1000}s`;
    console.log(logMessage);
    await fs.appendFile(LOG_FILE, logMessage + '\n');
    return new Promise(resolve => setTimeout(resolve, randomDelay));
}

// Helper: Validate a URL with axios (for non-Yahoo URLs)
async function validateUrl(url, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await axios.get(url, {
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36' }
            });
            return response.status === 200;
        } catch (error) {
            console.warn(`Attempt ${attempt + 1} failed for ${url}: ${error.message}`);
            if (attempt < retries - 1) await delay(2000, `Retrying URL validation for ${url}`);
        }
    }
    return false;
}

// Helper: Validate Yahoo Finance URL using yahoo-finance2
async function validateYahooFinanceUrl(ticker) {
    try {
        // Use a lightweight API call to check if the ticker exists
        const quote = await yahooFinance.quoteSummary(ticker, { modules: ['price'] });
        return !!quote.price; // Return true if price data exists
    } catch (error) {
        console.warn(`Yahoo Finance validation failed for ${ticker}: ${error.message}`);
        return false;
    }
}

// Helper: Validate ticker with Alpha Vantage as a fallback
async function validateAlphaVantageTicker(ticker) {
    const baseUrl = 'https://www.alphavantage.co/query';
    try {
        const response = await axios.get(`${baseUrl}?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${ALPHA_VANTAGE_KEY}`);
        const quoteData = response.data["Global Quote"];
        return quoteData && quoteData["05. price"] !== undefined;
    } catch (error) {
        console.warn(`Alpha Vantage validation failed for ${ticker}: ${error.message}`);
        return false;
    }
}

// Helper: Generate JMN-compatible slug from company name
function generateJmnSlug(companyName) {
    let slug = companyName
        .toLowerCase()
        .replace(/\s+(corp\.?|corporation|inc\.?|incorporated|ltd\.?|limited|co\.?|company|development|resources|mining)/gi, '')
        .trim();
    slug = slug.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    return slug;
}

// Helper: Check homepage relevance
function isRelevantHomepage(companyName, ticker, homepageUrl) {
    if (!homepageUrl) return false;
    const companySlug = companyName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
    const tickerSlug = ticker.toLowerCase().replace(/\.[a-z]+$/i, '');
    const homepageSlug = homepageUrl.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\.[a-z]+$/i, '');
    return homepageSlug.includes(companySlug) || homepageSlug.includes(tickerSlug);
}

// Helper: Scrape Junior Mining Network for company homepage
async function getJmnUrls(ticker, companyName) {
    const slug = generateJmnSlug(companyName);
    const jmnUrl = `https://www.juniorminingnetwork.com/market-data/stock-quote/${slug}.html`;
    try {
        const response = await axios.get(jmnUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36' }
        });
        const $ = cheerio.load(response.data);

        // Extract homepage (first external link likely to be the company website)
        let homepage = $('a[href*="http"]').filter((i, el) => {
            const href = $(el).attr('href');
            return (href.includes('.ca') || href.includes('.com')) && !href.includes('juniorminingnetwork.com');
        }).first().attr('href');

        if (homepage) {
            homepage = homepage.replace(/^https?:\/\//, '').replace(/\/$/, '');
            homepage = `https://${homepage}`;
            if (await validateUrl(homepage) && isRelevantHomepage(companyName, ticker, homepage)) {
                return { jmnUrl, homepage };
            } else {
                await db.run(
                    "INSERT INTO url_verification_log (company_ticker, url_type, attempted_url, status) VALUES (?, ?, ?, ?)",
                    [ticker, "homepage", homepage, "invalid or not relevant"]
                );
            }
        }
        return { jmnUrl, homepage: null };
    } catch (error) {
        console.warn(`Failed to fetch JMN page for ${ticker} (${companyName}): ${error.message}`);
        await db.run(
            "INSERT INTO url_verification_log (company_ticker, url_type, attempted_url, status) VALUES (?, ?, ?, ?)",
            [ticker, "jmn", jmnUrl, error.message]
        );
        return { jmnUrl: null, homepage: null };
    }
}

// Helper: Generate and validate URLs for a company
async function generateAndValidateUrls(ticker, companyName) {
    const urls = {
        homepage: null,
        pdf_report: null,
        yahoo_finance: null,
        jmn: null
    };

    // Priority 1: Yahoo Finance URL
    const yahooFinanceUrl = `https://finance.yahoo.com/quote/${ticker}/`;
    if (await validateYahooFinanceUrl(ticker) || await validateAlphaVantageTicker(ticker)) {
        urls.yahoo_finance = yahooFinanceUrl;
    } else {
        await db.run(
            "INSERT INTO url_verification_log (company_ticker, url_type, attempted_url, status) VALUES (?, ?, ?, ?)",
            [ticker, "yahoo_finance", yahooFinanceUrl, "invalid"]
        );
    }

    // Priority 2: Junior Mining Network URL and Homepage
    const { jmnUrl, homepage } = await getJmnUrls(ticker, companyName);
    if (jmnUrl) {
        urls.jmn = jmnUrl;
    }
    if (homepage) {
        urls.homepage = homepage;
    }

    // PDF reports (local files or URLs can be added later)
    return urls;
}

// Helper: Insert validated URLs into company_urls table
async function insertValidatedUrl(ticker, urlType, url) {
    if (!url) return;
    await db.run(
        "INSERT INTO company_urls (tsx_code, url_type, url, last_checked) VALUES (?, ?, ?, ?)",
        [ticker, urlType, url, new Date().toISOString()]
    );
    console.log(`Added ${urlType} URL for ${ticker}: ${url}`);
    await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Added ${urlType} URL for ${ticker}: ${url}\n`);
}

async function main() {
    try {
        const csvData = await fs.readFile(CSV_FILE, 'utf8');
        const cleanedCsvData = csvData.trim().replace(/^\ufeff/, '');
        const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });
        console.log(`Parsed ${companies.length} companies from CSV:`);
        console.log(companies.map(c => c.TICKER).join(', '));

        for (const company of companies) {
            const ticker = company.TICKER;
            const name = company.NAME || 'Unknown Name';
            if (!ticker || ticker === 'undefined') {
                console.error(`Invalid ticker found: ${JSON.stringify(company)}`);
                await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Skipping invalid ticker: ${JSON.stringify(company)}\n`);
                continue;
            }
            console.log(`Processing URLs for ${ticker} (${name})`);

            const urls = await generateAndValidateUrls(ticker, name);

            await insertValidatedUrl(ticker, 'homepage', urls.homepage);
            await insertValidatedUrl(ticker, 'yahoo_finance', urls.yahoo_finance);
            await insertValidatedUrl(ticker, 'jmn', urls.jmn);

            await delay(1000, `Pausing after processing URLs for ${ticker}`);
        }
    } catch (err) {
        console.error('Main failed:', err);
        await fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] Main failed: ${err.message}\n`);
    } finally {
        db.close();
    }
}

main();