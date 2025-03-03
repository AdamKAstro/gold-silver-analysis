const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs').promises;
const path = require('path');

const TICKERS = ['AAB.TO', 'AAG.V', 'AAN.V'];
const DATA_DIR = 'public/data/';

async function deepSearchTicker(ticker) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  // Search SEDAR+ for NI 43-101
  await page.goto(`https://www.sedarplus.ca/search/search_en?search_text=${ticker}`, { waitUntil: 'networkidle0' });
  const reportUrl = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a')).filter(a => a.textContent.includes('NI 43-101'));
    return links.length ? links[0].href : null;
  });

  let reservesGoldMoz = 0, reservesSilverMoz = 0, resourcesGoldMoz = 0, resourcesSilverMoz = 0;
  let productionAuEqKoz = 0, aiscLastYearValue = 0;

  if (reportUrl) {
    await page.goto(reportUrl, { waitUntil: 'networkidle0' });
    const text = await page.evaluate(() => document.body.innerText);
    // Parse for reserves/resources (simplified)
    const goldReserveMatch = text.match(/measured reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*gold/i);
    reservesGoldMoz = goldReserveMatch ? parseFloat(goldReserveMatch[1]) : 0;
    const silverReserveMatch = text.match(/measured reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*silver/i);
    reservesSilverMoz = silverReserveMatch ? parseFloat(silverReserveMatch[1]) : 0;
    // Similar for resources, production, AISC (simplified)
    resourcesGoldMoz = text.match(/indicated resources\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*gold/i) ? parseFloat(text.match(/indicated resources\s*:\s*(\d+(\.\d+)?)\s*million\s*ounces\s*gold/i)[1]) : 0;
    productionAuEqKoz = text.match(/annual production\s*:\s*(\d+)\s*koz/i) ? parseInt(text.match(/annual production\s*:\s*(\d+)\s*koz/i)[1]) : 0;
    const aiscMatch = text.match(/AISC\s*:\s*\$(\d+(\.\d+)?)\s*per\s*oz/i);
    aiscLastYearValue = aiscMatch ? parseFloat(aiscMatch[1]) : 0;
  }

  // Fallback to company website for missing data
  if (reservesGoldMoz === 0 || productionAuEqKoz === 0) {
    const companyName = await page.evaluate(() => document.querySelector('title')?.textContent.split(' - ')[0] || '');
    await page.goto(`https://www.google.com/search?q=${companyName}+investor+relations`, { waitUntil: 'networkidle0' });
    const irUrl = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).filter(a => a.textContent.toLowerCase().includes('investor'));
      return links.length ? links[0].href : null;
    });
    if (irUrl) {
      await page.goto(irUrl, { waitUntil: 'networkidle0' });
      const text = await page.evaluate(() => document.body.innerText);
      if (reservesGoldMoz === 0) reservesGoldMoz = text.match(/gold reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*oz/i) ? parseFloat(text.match(/gold reserves\s*:\s*(\d+(\.\d+)?)\s*million\s*oz/i)[1]) : reservesGoldMoz;
      if (productionAuEqKoz === 0) productionAuEqKoz = text.match(/production\s*:\s*(\d+)\s*koz/i) ? parseInt(text.match(/production\s*:\s*(\d+)\s*koz/i)[1]) : productionAuEqKoz;
      if (aiscLastYearValue === 0) aiscLastYearValue = text.match(/AISC\s*:\s*\$(\d+(\.\d+)?)\s*per\s*oz/i) ? parseFloat(text.match(/AISC\s*:\s*\$(\d+(\.\d+)?)\s*per\s*oz/i)[1]) : aiscLastYearValue;
    }
  }

  await browser.close();
  return { reservesGoldMoz, reservesSilverMoz, resourcesGoldMoz, resourcesSilverMoz, productionAuEqKoz, aiscLastYearValue };
}

// Main execution
async function main() {
  for (const ticker of TICKERS) {
    console.log(`Processing ${ticker}`);
    const data = await deepSearchTicker(ticker);
    const filePath = path.join(DATA_DIR, `${ticker}.json`);
    let jsonData;
    try {
      jsonData = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (e) {
      jsonData = { name: ticker, tsx_code: ticker };
    }
    Object.assign(jsonData, data, { last_updated_mining: new Date().toISOString() });
    await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
    console.log(`Updated ${ticker} with mining data:`, data);
  }
}

main().catch(err => console.error('Main failed:', err));
