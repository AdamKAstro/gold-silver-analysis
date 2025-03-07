const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const { parse } = require('csv-parse/sync');
const sqlite3 = require('sqlite3').verbose();
const yahooFinance = require('yahoo-finance2').default;
const urlModule = require('url');

// Configuration
const CSV_FILE = 'public/data/companies.csv';
const LOG_FILE = 'url_population_log.txt';
const DB_FILE = './mining_companies.db';
const RETRIES = 3;
const INITIAL_DELAY = 2000;
const MAX_DELAY = 10000;
const REQUEST_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 60000;
const BATCH_SIZE = 5;
const MAX_CONCURRENT = 2;
const PROTOCOL_TIMEOUT = 60000;

// Initialize Database
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) console.error(`[${new Date().toISOString()}] Database error: ${err.message}`);
    else console.log(`[${new Date().toISOString()}] Connected to database.`);
});

let isDbClosed = false;

// Utility Functions

async function log(message) {
    const msg = `[${new Date().toISOString()}] ${message}`;
    console.log(msg);
    await fs.appendFile(LOG_FILE, msg + '\n');
}

async function logVerification(ticker, urlType, url, status) {
    if (isDbClosed) return;
    try {
        await new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO url_verification_log (company_ticker, url_type, attempted_url, status, timestamp) VALUES (?, ?, ?, ?, ?)",
                [ticker, urlType, url, status, new Date().toISOString()],
                (err) => err ? reject(err) : resolve()
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
    return new Promise(resolve => setTimeout(resolve, randomDelay));
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
        const response = await validationPage.waitForResponse(res => res.status() >= 200 && res.status() < 300, { timeout: REQUEST_TIMEOUT });
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
        withoutSuffix.replace(/\s+/g, '').replace(/&/g, '')
    ];
    return [...new Set(slugs)].filter(slug => slug.length > 0);
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
        const links = $('a').map((i, el) => $(el).attr('href')).get();
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
        db.get("SELECT company_website, news_link FROM companies WHERE tsx_code = ?", [ticker], (err, row) => {
            if (err) reject(err);
            else resolve(row || {});
        });
    });
}

async function cleanNewsLink(ticker, newNewsLink) {
    const existing = await getExistingData(ticker);
    if (!existing.news_link || !await validateUrl(existing.news_link, ticker, 'news_link')) {
        try {
            await new Promise((resolve, reject) => {
                db.run(
                    "UPDATE companies SET news_link = ? WHERE tsx_code = ? AND (news_link IS NULL OR news_link != ?)",
                    [newNewsLink, ticker, newNewsLink],
                    (err) => err ? reject(err) : resolve()
                );
            });
            await log(`Updated news_link for ${ticker} to ${newNewsLink}`);
        } catch (error) {
            await log(`Failed to update news_link for ${ticker}: ${error.message}`);
        }
    }
}

async function processCompany(browser, company) {
    const ticker = company.TICKER;
    const name = company.NAME || 'Unknown Name';
    await log(`\n--- Processing ${ticker} (${name}) ---`);

    const existing = await getExistingData(ticker);
    if (existing.company_website && await validateHomepage(browser, existing.company_website)) {
        await log(`Skipping ${ticker}: Valid company_website exists (${existing.company_website})`);
        return;
    }

    const urls = { yahoo_finance: null, jmn: null, miningfeeds: null, homepage: null };
    let page;

    try {
        page = await browser.newPage();
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

        // Yahoo Finance
        const yahooFinanceUrl = `https://finance.yahoo.com/quote/${ticker}/`;
        if (await validateYahooFinanceUrl(ticker)) {
            urls.yahoo_finance = yahooFinanceUrl;
            await cleanNewsLink(ticker, yahooFinanceUrl);
            await page.goto(yahooFinanceUrl, { waitUntil: 'networkidle2' });
            urls.homepage = await extractHomepageFromPage(page, name, ticker, 'yahoo_finance');
        }

        // JMN
        if (!urls.homepage) {
            const jmnUrl = await findValidJmnUrl(name, ticker);
            if (jmnUrl) {
                urls.jmn = jmnUrl;
                await page.goto(jmnUrl, { waitUntil: 'networkidle2' });
                urls.homepage = await extractHomepageFromPage(page, name, ticker, 'jmn');
            }
        }

        // MiningFeeds
        if (!urls.homepage) {
            const exchange = getExchange(ticker);
            const miningFeedsUrl = generateMiningFeedsUrl(name, exchange);
            if (miningFeedsUrl && await validateUrl(miningFeedsUrl, ticker, 'miningfeeds')) {
                urls.miningfeeds = miningFeedsUrl;
                await page.goto(miningFeedsUrl, { waitUntil: 'networkidle2' });
                urls.homepage = await extractHomepageFromPage(page, name, ticker, 'miningfeeds');
            }
        }
    } catch (error) {
        await log(`Error processing ${ticker}: ${error.message}`);
        await logVerification(ticker, 'navigation', '', `failed: ${error.message}`);
    } finally {
        if (page) await page.close();
    }

    for (const [type, url] of Object.entries(urls)) {
        if (url) await insertValidatedUrl(ticker, type, url);
    }

    if (urls.homepage && (!existing.company_website || existing.company_website !== urls.homepage)) {
        await updateCompaniesTable(ticker, urls.homepage);
    }

    await delay(INITIAL_DELAY, `Pausing after ${ticker}`);
}

async function insertValidatedUrl(ticker, urlType, url) {
    if (isDbClosed) return;
    try {
        await new Promise((resolve, reject) => {
            db.run(
                "INSERT OR REPLACE INTO company_urls (tsx_code, url_type, url, last_checked) VALUES (?, ?, ?, ?)",
                [ticker, urlType, url, new Date().toISOString()],
                (err) => err ? reject(err) : resolve()
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
                "UPDATE companies SET company_website = ?, last_updated_homepage = ? WHERE tsx_code = ?",
                [homepage, new Date().toISOString(), ticker],
                (err) => err ? reject(err) : resolve()
            );
        });
        await log(`Updated company_website for ${ticker} to ${homepage}`);
    } catch (error) {
        await log(`Companies table update failed for ${ticker}: ${error.message}`);
    }
}

async function main() {
    try {
        await log('Starting URL population process...');
        const csvData = await fs.readFile(CSV_FILE, 'utf8');
        const companies = parse(csvData.trim().replace(/^\ufeff/, ''), { 
            columns: true, 
            skip_empty_lines: true, 
            trim: true 
        });

        const totalCompanies = companies.length;
        await log(`Loaded ${totalCompanies} companies from ${CSV_FILE}`);

        const browser = await puppeteer.launch({ 
            headless: true, 
            args: ['--no-sandbox'], 
            protocolTimeout: PROTOCOL_TIMEOUT 
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
            await log(`Processed batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(totalCompanies / BATCH_SIZE)} (${i + batch.length}/${totalCompanies})`);
        }

        await browser.close();
        isDbClosed = true;
        await log('Completed processing all companies');
    } catch (err) {
        await log(`Fatal error: ${err.message}`);
    } finally {
        if (!isDbClosed) {
            db.close((err) => {
                if (err) console.error(`[${new Date().toISOString()}] Error closing database: ${err.message}`);
                else console.log(`[${new Date().toISOString()}] Database connection closed.`);
            });
        }
    }
}

// Run the script
main();