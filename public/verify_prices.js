const puppeteer = require('puppeteer');
const yahooFinance = require('yahoo-finance2').default;
const { parse } = require('csv-parse');
const fs = require('fs').promises;
const path = require('path');

const COMPANIES_CSV = 'companies.csv';
const DATA_DIR = 'public/data/';
const LOG_FILE = 'verification_log.txt';
const CAD_THRESHOLD = 0.02; // 2% variance

async function fetchMiningFeeds(ticker) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const url = `https://www.miningfeeds.com/company/${ticker.toLowerCase().replace('.to', '').replace('.v', '')}/`;
    try {
        await page.goto(url, { waitUntil: 'networkidle2' });
        const price = await page.evaluate(() => {
            const el = document.querySelector('.stock-price'); // Adjust selector based on MiningFeeds HTML
            return el ? parseFloat(el.textContent.replace(/[^0-9.]/g, '')) : null;
        });
        const marketCap = await page.evaluate(() => {
            const el = document.querySelector('.market-cap'); // Adjust selector
            return el ? parseFloat(el.textContent.replace(/[^0-9.]/g, '')) * (el.textContent.includes('B') ? 1e9 : 1e6) : null;
        });
        await browser.close();
        return { price, marketCap, currency: 'CAD' };
    } catch (error) {
        console.error(`MiningFeeds error for ${ticker}: ${error}`);
        await browser.close();
        return { price: null, marketCap: null, currency: 'CAD' };
    }
}

async function fetchYahooFinance(ticker) {
    try {
        const quote = await yahooFinance.quote(ticker);
        return {
            price: quote.regularMarketPrice,
            marketCap: quote.marketCap,
            currency: quote.currency === 'CAD' ? 'CAD' : 'USD'
        };
    } catch (error) {
        console.error(`Yahoo Finance error for ${ticker}: ${error}`);
        return { price: null, marketCap: null, currency: 'CAD' };
    }
}

async function fetchGoogleFinance(ticker) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const url = `https://www.google.com/finance/quote/${ticker}:TSE`;
    try {
        await page.goto(url, { waitUntil: 'networkidle2' });
        const price = await page.evaluate(() => {
            const el = document.querySelector('[data-price]'); // Adjust selector
            return el ? parseFloat(el.textContent.replace(/[^0-9.]/g, '')) : null;
        });
        const marketCap = await page.evaluate(() => {
            const el = document.querySelector('.market-cap'); // Adjust selector
            return el ? parseFloat(el.textContent.replace(/[^0-9.]/g, '')) * (el.textContent.includes('B') ? 1e9 : 1e6) : null;
        });
        await browser.close();
        return { price, marketCap, currency: 'CAD' };
    } catch (error) {
        console.error(`Google Finance error for ${ticker}: ${error}`);
        await browser.close();
        return { price: null, marketCap: null, currency: 'CAD' };
    }
}

function resolveData(mf, yahoo, google, shares) {
    const log = [`[${ticker}] - ${new Date().toISOString().split('T')[0]}`];
    
    // Stock Price
    log.push("Stock Price:");
    log.push(`- MiningFeeds: ${mf.price || 'N/A'} ${mf.currency}`);
    log.push(`- Yahoo Finance: ${yahoo.price || 'N/A'} ${yahoo.currency}`);
    log.push(`- Google Finance: ${google.price || 'N/A'} ${google.currency}`);
    
    const validPrices = [mf.price, yahoo.price, google.price].filter(p => p && p > 0);
    const priceVariance = validPrices.length > 1 ? Math.max(...validPrices.map(p => Math.abs(p - mf.price) / mf.price)) : 0;
    log.push(`- Variance: ${priceVariance.toFixed(2)}%`);
    
    let finalPrice = mf.price;
    if (priceVariance > CAD_THRESHOLD || !mf.price) {
        finalPrice = validPrices.length >= 2 ? validPrices.reduce((a, b) => a + b) / validPrices.length : yahoo.price || google.price;
        log.push(`- Resolved: ${finalPrice} CAD (Source: Median or fallback)`);
    } else {
        log.push(`- Resolved: ${finalPrice} CAD (Source: MiningFeeds)`);
    }

    // Market Cap
    const calculatedMarketCap = finalPrice * shares;
    log.push("Market Cap:");
    log.push(`- MiningFeeds: ${mf.marketCap || 'N/A'} ${mf.currency}`);
    log.push(`- Yahoo Finance: ${yahoo.marketCap || 'N/A'} ${yahoo.currency}`);
    log.push(`- Google Finance: ${google.marketCap || 'N/A'} ${google.currency}`);
    log.push(`- Calculated: ${calculatedMarketCap} CAD`);
    
    const validCaps = [mf.marketCap, yahoo.marketCap, google.marketCap, calculatedMarketCap].filter(c => c && c > 0);
    const capVariance = validCaps.length > 1 ? Math.max(...validCaps.map(c => Math.abs(c - mf.marketCap) / mf.marketCap)) : 0;
    log.push(`- Variance: ${capVariance.toFixed(2)}%`);
    
    let finalMarketCap = mf.marketCap || calculatedMarketCap;
    if (capVariance > CAD_THRESHOLD || !mf.marketCap) {
        finalMarketCap = validCaps.reduce((a, b) => a + b) / validCaps.length;
        log.push(`- Resolved: ${finalMarketCap} CAD (Source: Median or calculated)`);
    } else {
        log.push(`- Resolved: ${finalMarketCap} CAD (Source: MiningFeeds)`);
    }

    return { price: finalPrice, marketCap: finalMarketCap, log };
}

async function updateJsonFile(ticker, data) {
    const filePath = path.join(DATA_DIR, `${ticker}.json`);
    let jsonData;
    try {
        jsonData = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        jsonData = { name: ticker, tsx_code: ticker }; // Default if file doesn’t exist
    }
    jsonData.stock_price = data.price;
    jsonData.market_cap_value = data.marketCap;
    jsonData.stock_price_currency = 'CAD';
    jsonData.market_cap_currency = 'CAD';
    jsonData.last_updated = new Date().toISOString();
    await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
}

async function processCompany(ticker, name) {
    const shares = JSON.parse(await fs.readFile(path.join(DATA_DIR, `${ticker}.json`), 'utf8')).number_of_shares || 0;
    const [mf, yahoo, google] = await Promise.all([
        fetchMiningFeeds(ticker),
        fetchYahooFinance(ticker),
        fetchGoogleFinance(ticker)
    ]);
    const { price, marketCap, log } = resolveData(mf, yahoo, google, shares);
    await updateJsonFile(ticker, { price, marketCap });
    await fs.appendFile(LOG_FILE, log.join('\n') + '\n\n');
    console.log(`Processed ${ticker}: Price=${price} CAD, Market Cap=${marketCap} CAD`);
}

async function main() {
    const csvData = await fs.readFile(COMPANIES_CSV, 'utf8');
    const companies = [];
    parse(csvData, { columns: true, trim: true }, (err, records) => {
        if (err) throw err;
        companies.push(...records);
    });

    for (const { ticker, name } of companies) {
        await processCompany(ticker, name);
    }
}

main().catch(console.error);