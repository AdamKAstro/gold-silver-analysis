const express = require('express');
const fetch = require('node-fetch');
const app = express();
const port = 3000;

// Mock API key (replace with your actual FMP_API_KEY for real testing)
const FMP_API_KEY = 'zUCYoFU4JoWsdWZlChltufkaWgKdBIUv';

app.use(express.json());

// Serve static files from the public directory
app.use(express.static('public'));

// API endpoint to mimic /api/data
app.get('/api/data', async (req, res) => {
  try {
    // Your existing data.js logic here (simplified for local testing)
    const companies = [
      { name: "Barrick Gold", ticker: "ABX.TO", reserves: 69, resources: 120, aisc: 1100, news: "https://example.com/news/barrick" },
      { name: "Newmont", ticker: "NEM", reserves: 92, resources: 140, aisc: 1000, news: "https://example.com/news/newmont" },
    ];

    const allData = await Promise.all(
      companies.map(async company => {
        const liveData = await fetchCompanyData(company.ticker);
        const evPerOz = !isNaN(liveData.ev) && company.reserves > 0 ? liveData.ev / company.reserves : NaN;
        const marketCapPerOz = !isNaN(liveData.marketCap) && company.reserves > 0 ? liveData.marketCap / company.reserves : NaN;
        return {
          name: company.name,
          ticker: company.ticker,
          stockPrice: liveData.stockPrice,
          marketCap: liveData.marketCap,
          ev: liveData.ev,
          reserves: company.reserves,
          resources: company.resources,
          aisc: company.aisc,
          revenue: liveData.revenue,
          profit: liveData.profit,
          news: company.news,
          evPerOz,
          marketCapPerOz
        };
      })
    );

    res.json(allData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

async function fetchCompanyData(ticker) {
  const fmpTicker = ticker.replace('.TO', '').replace('.V', '');
  try {
    console.log(`Fetching data for ${ticker}...`);
    const [profile, income, balance] = await Promise.all([
      fetch(`https://financialmodelingprep.com/api/v3/profile/${fmpTicker}?apikey=zUCYoFU4JoWsdWZlChltufkaWgKdBIUv`),
      fetch(`https://financialmodelingprep.com/api/v3/income-statement/${fmpTicker}?limit=1&apikey=zUCYoFU4JoWsdWZlChltufkaWgKdBIUv`),
      fetch(`https://financialmodelingprep.com/api/v3/balance-sheet-statement/${fmpTicker}?limit=1&apikey=zUCYoFU4JoWsdWZlChltufkaWgKdBIUv`)
    ]);

    const profileData = await profile.json();
    const incomeData = await income.json();
    const balanceData = await balance.json();

    console.log(`Profile data for ${ticker}:`, profileData);
    console.log(`Income data for ${ticker}:`, incomeData);
    console.log(`Balance data for ${ticker}:`, balanceData);

    const profileItem = profileData[0] || {};
    const incomeItem = incomeData[0] || {};
    const balanceItem = balanceData[0] || {};

    const currency = profileItem.currency || 'CAD';
    const isUSD = currency === 'USD';
    const exchangeRate = 1.35; // Simplified for local testing

    const stockPrice = parseFloat(profileItem.price) || NaN; // Fallback to NaN if price is null/undefined
    if (stockPrice === NaN) console.warn(`Stock price for ${ticker} is NaN or missing`);

    const marketCapRaw = parseFloat(profileItem.mktCap) || NaN;
    const marketCapCAD = !isNaN(marketCapRaw) ? (isUSD ? (marketCapRaw * exchangeRate / 1e6) : (marketCapRaw / 1e6)) : NaN;
    const revenueRaw = parseFloat(incomeItem.revenue) || NaN;
    const profitRaw = parseFloat(incomeItem.netIncome) || NaN;
    const revenueCAD = !isNaN(revenueRaw) ? (isUSD ? (revenueRaw * exchangeRate / 1e6) : (revenueRaw / 1e6)) : NaN;
    const profitCAD = !isNaN(profitRaw) ? (isUSD ? (profitRaw * exchangeRate / 1e6) : (profitRaw / 1e6)) : NaN;
    const debtCAD = (parseFloat(balanceItem.totalDebt) || 0) * (isUSD ? exchangeRate / 1e6 : 1 / 1e6);
    const cashCAD = (parseFloat(balanceItem.cashAndEquivalents) || 0) * (isUSD ? exchangeRate / 1e6 : 1 / 1e6);
    const evCAD = !isNaN(marketCapCAD) ? (marketCapCAD + debtCAD - cashCAD) : NaN;

    console.log(`Processed data for ${ticker}:`, { stockPrice, marketCap: marketCapCAD, ev: evCAD, revenue: revenueCAD, profit: profitCAD });
    return { stockPrice, marketCap: marketCapCAD, ev: evCAD, revenue: revenueCAD, profit: profitCAD };
  } catch (error) {
    console.error(`Error fetching ${ticker}:`, error);
    return { stockPrice: NaN, marketCap: NaN, ev: NaN, revenue: NaN, profit: NaN };
  }
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});