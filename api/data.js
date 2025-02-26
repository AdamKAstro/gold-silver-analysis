const fetch = require('node-fetch');

const FMP_API_KEY = process.env.FMP_API_KEY;
const CACHE_EXPIRY = 15 * 60 * 1000; // 15 minutes
let cachedData = null;
let lastFetchTime = 0;

const companies = [
    { name: "Barrick Gold", ticker: "ABX.TO", reserves: 69, resources: 120, aisc: 1100, news: "https://example.com/news/barrick" },
    { name: "Newmont", ticker: "NEM", reserves: 92, resources: 140, aisc: 1000, news: "https://example.com/news/newmont" },
    // Add your full companies list here
];

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
    }
}

async function fetchExchangeRate() {
    try {
        const data = await fetchWithRetry('https://api.exchangerate.host/convert?from=USD&to=CAD');
        return data.result || 1.35;
    } catch {
        return 1.35;
    }
}

async function fetchCompanyData(ticker) {
    const fmpTicker = ticker.replace('.TO', '').replace('.V', '');
    const [profile, income, balance] = await Promise.all([
        fetchWithRetry(`https://financialmodelingprep.com/api/v3/profile/${fmpTicker}?apikey=${FMP_API_KEY}`),
        fetchWithRetry(`https://financialmodelingprep.com/api/v3/income-statement/${fmpTicker}?limit=1&apikey=${FMP_API_KEY}`),
        fetchWithRetry(`https://financialmodelingprep.com/api/v3/balance-sheet-statement/${fmpTicker}?limit=1&apikey=${FMP_API_KEY}`)
    ]);

    const profileData = profile[0] || {};
    const incomeData = income[0] || {};
    const balanceData = balance[0] || {};
    const currency = profileData.currency || 'CAD';
    const isUSD = currency === 'USD';
    const exchangeRate = await fetchExchangeRate();

    const stockPrice = parseFloat(profileData.price) || NaN;
    const marketCapRaw = parseFloat(profileData.mktCap) || NaN;
    const marketCapCAD = !isNaN(marketCapRaw) ? (isUSD ? (marketCapRaw * exchangeRate / 1e6) : (marketCapRaw / 1e6)) : NaN;
    const revenueRaw = parseFloat(incomeData.revenue) || NaN;
    const profitRaw = parseFloat(incomeData.netIncome) || NaN;
    const revenueCAD = !isNaN(revenueRaw) ? (isUSD ? (revenueRaw * exchangeRate / 1e6) : (revenueRaw / 1e6)) : NaN;
    const profitCAD = !isNaN(profitRaw) ? (isUSD ? (profitRaw * exchangeRate / 1e6) : (profitRaw / 1e6)) : NaN;
    const debtCAD = (parseFloat(balanceData.totalDebt) || 0) * (isUSD ? exchangeRate / 1e6 : 1 / 1e6);
    const cashCAD = (parseFloat(balanceData.cashAndEquivalents) || 0) * (isUSD ? exchangeRate / 1e6 : 1 / 1e6);
    const evCAD = !isNaN(marketCapCAD) ? (marketCapCAD + debtCAD - cashCAD) : NaN;

    return { stockPrice, marketCap: marketCapCAD, ev: evCAD, revenue: revenueCAD, profit: profitCAD };
}

module.exports = async (req, res) => {
    if (Date.now() - lastFetchTime < CACHE_EXPIRY && cachedData) {
        return res.setHeader('Cache-Control', 'public, max-age=900').json(cachedData);
    }

    try {
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

        cachedData = allData;
        lastFetchTime = Date.now();
        res.setHeader('Cache-Control', 'public, max-age=900').json(allData);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch data' });
    }
};