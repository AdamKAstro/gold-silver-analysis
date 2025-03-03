const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const delays = [1000, 2000, 3000, 4000, 5000]; // Test delays in ms
const ticker = 'AAB.TO';
const exchange = 'TSX';
const cleanTicker = ticker.replace('.', '-');
const url = `https://www.tradingview.com/symbols/${exchange}-${cleanTicker}/`;

async function testDelay(delayMs) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  try {
    await page.goto(url, { waitUntil: 'networkidle0' });
    await new Promise(resolve => setTimeout(resolve, delayMs)); // Fixed delay
    const price = await page.evaluate(() => document.querySelector('.js-symbol-last')?.textContent.trim() || 'N/A');
    console.log(`Delay: ${delayMs}ms, Price: ${price}`);
  } catch (e) {
    console.error(`Delay: ${delayMs}ms failed - ${e.message}`);
  } finally {
    await browser.close();
  }
}

async function runTests() {
  for (const delayMs of delays) {
    await testDelay(delayMs);
    await new Promise(resolve => setTimeout(resolve, 5000)); // Delay between tests
  }
}

runTests();