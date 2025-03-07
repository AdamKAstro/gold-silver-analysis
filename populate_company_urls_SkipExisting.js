// Ensure all required modules are imported correctly
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3').verbose(); // Use verbose mode for detailed errors
const yahooFinance = require('yahoo-finance2').default;
const urlModule = require('url');

// Configuration
const CSV_FILE = 'public/data/companies.csv'; // Path to your CSV
const LOG_FILE = 'url_population_log.txt'; // Log file path
const DB_FILE = './mining_companies.db'; // Path to your existing database
const RETRIES = 3;
const INITIAL_DELAY = 2000;
const MAX_DELAY = 10000;
const REQUEST_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 60000;
const BATCH_SIZE = 5;
const MAX_CONCURRENT = 2;
const PROTOCOL_TIMEOUT = 60000;
const SKIP_DAYS = 3; // Skip companies processed within the last 3 days
const VALIDATION_THRESHOLD_DAYS = 7; // Consider URLs valid within 7 days

// Initialize Database with explicit read-write mode
const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
        console.error(`[${new Date().toISOString()}] Database connection failed: ${err.message}`);
        console.error('Ensure mining_companies.db exists at', DB_FILE);
        process.exit(1); // Exit if connection fails
    } else {
        console.log(`[${new Date().toISOString()}] Connected to existing database at ${DB_FILE}`);
    }
});

let isDbClosed = false;

// Utility Functions

async function log(message) {
    const msg = `[${new Date().toISOString()}] ${message}`;
    console.log(msg);
    try {
        await fs.appendFile(LOG_FILE, msg + '\n');
    } catch (err) {
        console.error(`Failed to write to log: ${err.message}`);
    }
}

async function logVerification(ticker, urlType, url, status) {
    if (isDbClosed) return;
    try {
        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO url_verification_log (company_ticker, url_type, attempted_url, status, timestamp) VALUES (?, ?, ?, ?, ?)',
                [ticker, urlType, url, status, new Date().toISOString()],
                (err) => (err ? reject(err) : resolve())
            );
        });
    } catch (error) {
        await log(`Failed to log verification for ${ticker}: ${error.message}`);
    }
}

async function delay(ms, reason = 'Pausing', attempt = 1) {
    const backoff = Math.min(ms * Math.pow(2, attempt - 1), MAX_DELAY);
    const randomDelay = backoff + Math.floor(Math.random() * 1000);
    await log(`${reason} for ${randomDelay / 1000}s (attempt ${attempt})`);
    return new Promise((resolve) => setTimeout(resolve, randomDelay));
}

async function validateUrl(url, ticker, urlType) {
    for (let i = 0; i < RETRIES; i++) {
        try {
            const response = await axios.head(url, { timeout: REQUEST_TIMEOUT });
            const isValid = response.status === 200;
            await logVerification(ticker, urlType, url, isValid ? 'valid' : `invalid (status ${response.status})`);
            return isValid;
        } catch (error) {
            const status = error.response ? `status ${error.response.status}` : error.message;
            await logVerification(ticker, urlType, url, `failed: ${status}`);
            if (i < RETRIES - 1 && (!error.response || error.response.status !== 404)) {
                await delay(INITIAL_DELAY, `Retrying validation for ${url}`, i + 1);
            }
        }
    }
    return false;
}

async function validateYahooFinanceUrl(ticker) {
    try {
        const quote = await yahooFinance.quoteSummary(ticker, { modules: ['price'] });
        const isValid = !!quote.price;
        await logVerification(ticker, 'yahoo_finance', `https://finance.yahoo.com/quote/${ticker}/`, isValid ? 'valid' : 'invalid');
        return isValid;
    } catch (error) {
        await logVerification(ticker, 'yahoo_finance', `https://finance.yahoo.com/quote/${ticker}/`, `failed: ${error.message}`);
        return false;
    }
}

async function validateHomepage(browser, url) {
    const validationPage = await browser.newPage();
    try {
        await validationPage.goto(url, { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT });
        const finalUrl = validationPage.url();
        const response = await validationPage.waitForResponse(
            (res) => res.status() >= 200 && res.status() < 300,
            { timeout: REQUEST_TIMEOUT }
        );
        if (response) {
            await log(`Validated URL: ${finalUrl}`);
            return finalUrl;
        }
        await log(`Invalid URL after navigation: ${finalUrl}`);
        return false;
    } catch (error) {
        await log(`Validation failed for ${url}: ${error.message}`);
        return false;
    } finally {
        await validationPage.close();
    }
}

function generateSlugs(companyName) {
    const baseName = companyName.toLowerCase().replace(/[^a-z0-9\s&]/g, '').trim();
    const withoutSuffix = baseName.replace(/\b(ltd|inc|corp|limited|incorporated)\b/gi, '').trim();
    const slugs = [
        baseName.replace(/\s+/g, '-'),
        baseName.replace(/\s+/g, ''),
        withoutSuffix.replace(/\s+/g, '-'),
        withoutSuffix.replace(/\s+/g, ''),
        baseName.replace(/\s+/g, '-').replace(/&/g, '--'),
        withoutSuffix.replace(/\s+/g, '-').replace(/&/g, '--'),
        baseName.replace(/\s+/g, '').replace(/&/g, ''),
        withoutSuffix.replace(/\s+/g, '').replace(/&/g, ''),
    ];
    return [...new Set(slugs)].filter((slug) => slug.length > 0);
}

async function findValidJmnUrl(companyName, ticker) {
    const slugs = generateSlugs(companyName);
    for (const slug of slugs) {
        const url = `https://www.juniorminingnetwork.com/market-data/stock-quote/${slug}.html`;
        if (await validateUrl(url, ticker, 'jmn')) {
            return url;
        }
    }
    return null;
}

function getExchange(ticker) {
    const mappings = { '.TO': 'tsx', '.V': 'tsxv', '.CN': 'cse' };
    return mappings[ticker.slice(-3)] || null;
}

function generateMiningFeedsUrl(companyName, exchange) {
    if (!exchange) return null;
    const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    return `https://www.miningfeeds.com/stock/${slug}-${exchange}/`;
}

function cleanUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let cleaned = url.trim().replace(/[.,;:!?]$/, '');
    if (cleaned.startsWith('www.')) cleaned = `https://${cleaned}`;
    if (!cleaned.startsWith('http')) cleaned = `https://${cleaned}`;
    return cleaned.endsWith('/') ? cleaned.slice(0, -1) : cleaned;
}

async function extractHomepageFromPage(page, companyName, ticker, source) {
    const browser = page.browser();
    try {
        const content = await page.content();
        const $ = cheerio.load(content);
        let homepage = null;

        if (source === 'jmn') {
            homepage = $('a:contains("Company Website"), a:contains("Visit Website"), .stock-header a').attr('href');
        } else if (source === 'yahoo_finance') {
            homepage = $('a[title="Company Site"], a:contains("Website")').attr('href');
        } else if (source === 'miningfeeds') {
            homepage = $('.company-info a, a:contains("Official Website")').attr('href');
        }

        if (homepage) {
            homepage = urlModule.resolve(page.url(), homepage);
            const finalUrl = await validateHomepage(browser, homepage);
            if (finalUrl) {
                await log(`Found homepage from ${source} for ${companyName}: ${finalUrl}`);
                return finalUrl;
            } else {
                await log(`Homepage from ${source} invalid: ${homepage}`);
            }
        }

        const companyLower = companyName.toLowerCase().replace(/\s+/g, '');
        const links = $('a')
            .map((i, el) => $(el).attr('href'))
            .get();
        let attempts = 0;
        for (let link of links) {
            if (attempts >= 3) break;
            link = urlModule.resolve(page.url(), link);
            if (link && link.toLowerCase().includes(companyLower)) {
                const finalUrl = await validateHomepage(browser, link);
                if (finalUrl) {
                    await log(`Found homepage from ${source} for ${companyName}: ${finalUrl}`);
                    return finalUrl;
                }
                attempts++;
            }
        }

        await log(`No valid homepage found on ${source} for ${companyName}`);
        return null;
    } catch (error) {
        await log(`Error extracting homepage from ${source} for ${companyName}: ${error.message}`);
        return null;
    }
}

async function getExistingData(ticker) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT company_website, last_updated_homepage, last_url_population_attempt FROM companies WHERE tsx_code = ?',
            [ticker],
            (err, row) => {
                if (err) reject(err);
                else resolve(row || {});
            }
        );
    });
}

async function getExistingUrls(ticker) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT url_type, url, last_checked FROM company_urls WHERE tsx_code = ?',
            [ticker],
            (err, rows) => {
                if (err) reject(err);
                else {
                    const urls = {};
                    rows.forEach((row) => {
                        urls[row.url_type] = { url: row.url, last_checked: row.last_checked };
                    });
                    resolve(urls);
                }
            }
        );
    });
}

async function cleanNewsLink(ticker, newNewsLink) {
    const existing = await getExistingData(ticker);
    if (!existing.news_link || !(await validateUrl(existing.news_link, ticker, 'news_link'))) {
        try {
            await new Promise((resolve, reject) => {
                db.run(
                    'UPDATE companies SET news_link = ? WHERE tsx_code = ? AND (news_link IS NULL OR news_link != ?)',
                    [newNewsLink, ticker, newNewsLink],
                    (err) => (err ? reject(err) : resolve())
                );
            });
            await log(`Updated news_link for ${ticker} to ${newNewsLink}`);
        } catch (error) {
            await log(`Failed to update news_link for ${ticker}: ${error.message}`);
        }
    }
}

function isRecentlyValidated(lastChecked) {
    if (!lastChecked) return false;
    const daysSince = (new Date() - new Date(lastChecked)) / (1000 * 60 * 60 * 24);
    return daysSince < VALIDATION_THRESHOLD_DAYS;
}

async function processCompany(browser, company) {
    const ticker = company.TICKER;
    const name = company.NAME || 'Unknown Name';
    await log(`\n--- Processing ${ticker} (${name}) ---`);

    const existing = await getExistingData(ticker);
    const existingUrls = await getExistingUrls(ticker);

    // Check if the company was recently processed
    const lastAttempt = existing.last_url_population_attempt
        ? new Date(existing.last_url_population_attempt)
        : null;
    const daysSinceLastAttempt = lastAttempt
        ? (new Date() - lastAttempt) / (1000 * 60 * 60 * 24)
        : Infinity;
    if (daysSinceLastAttempt < SKIP_DAYS) {
        await log(`Skipping ${ticker}: Last attempted ${daysSinceLastAttempt.toFixed(1)} days ago`);
        return;
    }

    // Check if there's a valid homepage
    let homepage = null;
    const isHomepageRecent = existing.company_website && isRecentlyValidated(existing.last_updated_homepage);
    if (isHomepageRecent) {
        homepage = existing.company_website;
        await log(`Skipping homepage extraction for ${ticker}: Using existing valid company_website ${homepage}`);
        await updateLastAttempt(ticker); // Update attempt timestamp
        return; // Skip further processing
    }

    // If no valid homepage, attempt to extract it
    const sources = ['yahoo_finance', 'jmn', 'miningfeeds'];
    for (const source of sources) {
        let sourceUrl = null;
        if (existingUrls[source] && isRecentlyValidated(existingUrls[source].last_checked)) {
            sourceUrl = existingUrls[source].url;
            await log(`Using existing ${source} URL for ${ticker}: ${sourceUrl}`);
        } else {
            if (source === 'yahoo_finance') {
                const yahooFinanceUrl = `https://finance.yahoo.com/quote/${ticker}/`;
                if (await validateYahooFinanceUrl(ticker)) {
                    sourceUrl = yahooFinanceUrl;
                    await insertValidatedUrl(ticker, 'yahoo_finance', sourceUrl);
                    await cleanNewsLink(ticker, sourceUrl);
                }
            } else if (source === 'jmn') {
                const jmnUrl = await findValidJmnUrl(name, ticker);
                if (jmnUrl) {
                    sourceUrl = jmnUrl;
                    await insertValidatedUrl(ticker, 'jmn', sourceUrl);
                }
            } else if (source === 'miningfeeds') {
                const exchange = getExchange(ticker);
                const miningFeedsUrl = generateMiningFeedsUrl(name, exchange);
                if (miningFeedsUrl && (await validateUrl(miningFeedsUrl, ticker, 'miningfeeds'))) {
                    sourceUrl = miningFeedsUrl;
                    await insertValidatedUrl(ticker, 'miningfeeds', sourceUrl);
                }
            }
        }
        if (sourceUrl) {
            let page;
            try {
                page = await browser.newPage();
                page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
                await page.goto(sourceUrl, { waitUntil: 'networkidle2' });
                const extractedHomepage = await extractHomepageFromPage(page, name, ticker, source);
                if (extractedHomepage) {
                    homepage = extractedHomepage;
                    break; // Found a homepage, stop checking other sources
                }
            } catch (error) {
                await log(`Error extracting homepage from ${source} for ${ticker}: ${error.message}`);
                await logVerification(ticker, source, sourceUrl, `failed: ${error.message}`);
            } finally {
                if (page) await page.close();
            }
        }
    }

    if (homepage) {
        await updateCompaniesTable(ticker, homepage);
    } else {
        await log(`No valid homepage found for ${ticker}`);
    }

    await updateLastAttempt(ticker);
    await delay(INITIAL_DELAY, `Pausing after ${ticker}`);
}

async function insertValidatedUrl(ticker, urlType, url) {
    if (isDbClosed) return;
    try {
        await new Promise((resolve, reject) => {
            db.run(
                'INSERT OR REPLACE INTO company_urls (tsx_code, url_type, url, last_checked) VALUES (?, ?, ?, ?)',
                [ticker, urlType, url, new Date().toISOString()],
                (err) => (err ? reject(err) : resolve())
            );
        });
        await log(`Inserted/Updated ${urlType} URL for ${ticker}: ${url}`);
    } catch (error) {
        await log(`Database insert/update failed for ${ticker} (${urlType}): ${error.message}`);
    }
}

async function updateCompaniesTable(ticker, homepage) {
    if (isDbClosed) return;
    try {
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE companies SET company_website = ?, last_updated_homepage = ? WHERE tsx_code = ?',
                [homepage, new Date().toISOString(), ticker],
                (err) => (err ? reject(err) : resolve())
            );
        });
        await log(`Updated company_website for ${ticker} to ${homepage}`);
    } catch (error) {
        await log(`Companies table update failed for ${ticker}: ${error.message}`);
    }
}

async function updateLastAttempt(ticker) {
    if (isDbClosed) return;
    try {
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE companies SET last_url_population_attempt = ? WHERE tsx_code = ?',
                [new Date().toISOString(), ticker],
                (err) => (err ? reject(err) : resolve())
            );
        });
        await log(`Updated last_url_population_attempt for ${ticker}`);
    } catch (error) {
        await log(`Failed to update last_url_population_attempt for ${ticker}: ${error.message}`);
    }
}

async function main() {
    try {
        await log('Starting URL population process...');
        const csvData = await fs.readFile(CSV_FILE, 'utf8');
        const companies = parse(csvData.trim().replace(/^\ufeff/, ''), {
            columns: true,
            skip_empty_lines: true,
            trim: true,
        });

        const totalCompanies = companies.length;
        await log(`Loaded ${totalCompanies} companies from ${CSV_FILE}`);

        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox'],
            protocolTimeout: PROTOCOL_TIMEOUT,
        });

        for (let i = 0; i < totalCompanies; i += BATCH_SIZE) {
            const batch = companies.slice(i, i + BATCH_SIZE);
            const processingPromises = [];
            for (const company of batch) {
                if (processingPromises.length >= MAX_CONCURRENT) {
                    await Promise.race(processingPromises);
                    processingPromises.splice(0, 1);
                }
                processingPromises.push(processCompany(browser, company));
            }
            await Promise.all(processingPromises);
            await log(
                `Processed batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(totalCompanies / BATCH_SIZE)} (${
                    i + batch.length
                }/${totalCompanies})`
            );
        }

        await browser.close();
        await log('Completed processing all companies');
    } catch (err) {
        await log(`Fatal error: ${err.message}`);
    } finally {
        if (!isDbClosed) {
            await new Promise((resolve) => {
                db.close((err) => {
                    if (err) console.error(`[${new Date().toISOString()}] Error closing database: ${err.message}`);
                    else console.log(`[${new Date().toISOString()}] Database connection closed`);
                    isDbClosed = true;
                    resolve();
                });
            });
        }
    }
}

// Run the script
main();