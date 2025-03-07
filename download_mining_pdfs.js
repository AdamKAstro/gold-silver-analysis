const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises; // Use promise-based fs, like your script
const fsExtra = require('fs-extra'); // For synchronous dir creation
const { parse } = require('csv-parse/sync');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// Configuration
const CSV_FILE = 'public/data/companies.csv'; // Matches your financial script
const OUTPUT_DIR = './public/data/PDFs/';
const LOG_FILE = 'pdf_download_log.txt';
const MAX_DEPTH = 3;
const DELAY_MS = 2000;
const MAX_RETRIES = 3;

// Ensure output directory exists (synchronous for simplicity at startup)
fsExtra.ensureDirSync(OUTPUT_DIR);

// Logging function (async to match your style)
async function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    await fs.appendFile(LOG_FILE, logMessage);
    console.log(logMessage.trim());
}

// Initialize SQLite database
const db = new sqlite3.Database('./mining_companies.db', (err) => {
    if (err) {
        console.error(`[ERROR] Database connection failed: ${err.message}`);
        process.exit(1);
    } else {
        console.log('[INFO] Connected to the database.');
    }
});

// Load companies from CSV, mimicking your financial script
async function loadCompanies() {
    try {
        const csvData = await fs.readFile(CSV_FILE, 'utf8');
        const cleanedCsvData = csvData.trim().replace(/^\ufeff/, ''); // Remove BOM
        const companies = parse(cleanedCsvData, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });

        // Clean BOM from keys, as in your script
        companies.forEach(company => {
            Object.keys(company).forEach(key => {
                const cleanedKey = key.replace(/^\ufeff/, '');
                if (cleanedKey !== key) {
                    company[cleanedKey] = company[key];
                    delete company[key];
                    console.log(`[INFO] Cleaned BOM from key '${key}' to '${cleanedKey}' for company: ${JSON.stringify(company)}`);
                }
            });
        });

        await log(`Parsed ${companies.length} companies from CSV: ${companies.map(c => c.TICKER).join(', ')}`);
        return companies;
    } catch (err) {
        await log(`Failed to load companies from CSV: ${err.message}`, 'ERROR');
        throw err;
    }
}

// Infer PDF type and year
function inferPdfDetails(pdfUrl) {
    const filename = pdfUrl.split('/').pop().toLowerCase();
    let type = 'Unknown';
    let year = 'Unknown';

    if (/annual|ar\d{4}/.test(filename)) type = 'AnnualReport';
    else if (/ni43-?101|technical/i.test(filename)) type = 'NI43101';
    else if (/quarterly|qr\d{4}/.test(filename)) type = 'QuarterlyReport';
    else if (/financial/i.test(filename)) type = 'FinancialStatement';

    const yearMatch = filename.match(/\d{4}/);
    if (yearMatch) year = yearMatch[0];

    return { type, year };
}

// Download PDF with retries
async function downloadPdf(url, outputPath, retries = 0) {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: 30000,
        });

        const writer = fsExtra.createWriteStream(outputPath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(true));
            writer.on('error', (err) => reject(err));
        });
    } catch (error) {
        if (retries < MAX_RETRIES) {
            await log(`Retrying download for ${url} (${retries + 1}/${MAX_RETRIES})`, 'WARN');
            await new Promise(resolve => setTimeout(resolve, DELAY_MS));
            return downloadPdf(url, outputPath, retries + 1);
        }
        throw error;
    }
}

// Crawl website and collect PDF paths
async function crawlWebsite(browser, url, ticker, visited = new Set(), depth = 0) {
    if (depth > MAX_DEPTH || visited.has(url)) return [];

    visited.add(url);
    const downloadedPaths = [];

    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const content = await page.content();
        const $ = cheerio.load(content);

        const links = [];
        $('a[href]').each((i, elem) => {
            let href = $(elem).attr('href');
            if (!href) return;

            href = new URL(href, url).href;
            if (href.endsWith('.pdf')) {
                const { type, year } = inferPdfDetails(href);
                const filename = `${ticker}_${type}_${year}_${href.split('/').pop()}`;
                const outputPath = path.join(OUTPUT_DIR, filename);

                if (!fsExtra.existsSync(outputPath)) {
                    try {
                        await downloadPdf(href, outputPath);
                        await log(`Downloaded: ${outputPath}`);
                        downloadedPaths.push(outputPath);
                    } catch (error) {
                        await log(`Failed to download ${href}: ${error.message}`, 'ERROR');
                    }
                } else {
                    await log(`Skipped (exists): ${outputPath}`);
                    downloadedPaths.push(outputPath);
                }
            } else if (href.startsWith('http') && !visited.has(href)) {
                links.push(href);
            }
        });

        await page.close();

        for (const link of links) {
            const subPaths = await crawlWebsite(browser, link, ticker, visited, depth + 1);
            downloadedPaths.push(...subPaths);
        }
    } catch (error) {
        await log(`Failed to crawl ${url}: ${error.message}`, 'ERROR');
    }

    return downloadedPaths;
}

// Update database with PDF paths
async function updatePdfSources(ticker, paths) {
    const pdfSourcesJson = JSON.stringify(paths);
    const sql = `UPDATE companies SET pdf_sources = ? WHERE tsx_code = ?`;
    return new Promise((resolve, reject) => {
        db.run(sql, [pdfSourcesJson, ticker], async function(err) {
            if (err) {
                await log(`Failed to update pdf_sources for ${ticker}: ${err.message}`, 'ERROR');
                reject(err);
            } else if (this.changes === 0) {
                await log(`No company found with tsx_code ${ticker}`, 'WARN');
                resolve();
            } else {
                await log(`Updated pdf_sources for ${ticker} with ${paths.length} PDFs`);
                resolve();
            }
        });
    });
}

// Main function
async function main() {
    await log('Starting PDF download script...');

    const companies = await loadCompanies();
    const browser = await puppeteer.launch({ headless: true });

    for (const company of companies) {
        try {
            const { TICKER: ticker, company_website } = company;
            if (!ticker || !company_website) {
                await log(`Skipping company with missing TICKER or company_website: ${JSON.stringify(company)}`, 'WARN');
                continue;
            }

            await log(`Crawling ${company_website} for ${ticker}...`);
            const downloadedPaths = await crawlWebsite(browser, company_website, ticker);
            await log(`Found and processed ${downloadedPaths.length} PDFs for ${ticker}`);

            await updatePdfSources(ticker, downloadedPaths);
        } catch (error) {
            await log(`Error processing ${company.TICKER || 'unknown'}: ${error.message}`, 'ERROR');
        }
        await new Promise(resolve => setTimeout(resolve, DELAY_MS * 2));
    }

    await browser.close();
    db.close(async (err) => {
        if (err) await log(`Failed to close database: ${err.message}`, 'ERROR');
        else await log('Database connection closed.');
    });
    await log('PDF download script completed.');
}

// Run the script
main().catch(async (error) => {
    await log(`Script failed: ${error.message}`, 'ERROR');
    process.exit(1);
});