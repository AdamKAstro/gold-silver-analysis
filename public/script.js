const tbody = document.getElementById('miningTableBody');
const table = document.getElementById('miningTable');
const searchInput = document.getElementById('searchInput');
const statusLog = document.getElementById('statusLog');
const spinner = document.getElementById('spinner');
const sliders = {
    marketCap: { slider: document.getElementById('marketCapSlider'), valueSpan: document.getElementById('marketCapValue'), dir: document.getElementById('marketCapDir') },
    ev: { slider: document.getElementById('evSlider'), valueSpan: document.getElementById('evValue'), dir: document.getElementById('evDir') },
    // Add more sliders here as needed
};

function logStatus(message) {
    statusLog.innerHTML += `<div>${new Date().toLocaleTimeString()}: ${message}</div>`;
    statusLog.scrollTop = statusLog.scrollHeight;
}

async function fetchAllData() {
    try {
        const res = await fetch('/api/data');
        if (!res.ok) throw new Error('Failed to fetch data');
        const data = await res.json();
        logStatus('Data fetched successfully');
        return data;
    } catch (error) {
        logStatus(`Error fetching data: ${error.message}`);
        return [];
    }
}

async function populateTable() {
    spinner.style.display = 'block';
    logStatus('Starting data fetch...');
    const allData = await fetchAllData();
    spinner.style.display = 'none';

    if (!allData.length) {
        statusLog.innerHTML = 'Unable to load data. Please try again later.';
        return;
    }

    const means = {
        marketCap: allData.filter(d => !isNaN(d.marketCap)).reduce((sum, d) => sum + d.marketCap, 0) / allData.filter(d => !isNaN(d.marketCap)).length || 1000,
        ev: allData.filter(d => !isNaN(d.ev)).reduce((sum, d) => sum + d.ev, 0) / allData.filter(d => !isNaN(d.ev)).length || 1000,
        // Add more means as needed
    };

    allData.forEach(data => {
        const imputed = {
            marketCap: !isNaN(data.marketCap) ? data.marketCap : means.marketCap,
            ev: !isNaN(data.ev) ? data.ev : means.ev,
            // Add more imputations as needed
        };

        const row = document.createElement('tr');
        row.classList.add('tooltip');
        row.innerHTML = `
            <td>${data.name}</td>
            <td>${data.ticker}</td>
            <td data-value="${data.stockPrice}">${isFinite(data.stockPrice) ? data.stockPrice.toFixed(2) : 'N/A'}</td>
            <td data-value="${imputed.marketCap}">${isFinite(data.marketCap) ? data.marketCap.toFixed(2) : 'N/A'}</td>
            <td data-value="${imputed.ev}">${isFinite(data.ev) ? data.ev.toFixed(2) : 'N/A'}</td>
            <td data-value="${data.reserves}">${data.reserves}</td>
            <td data-value="${data.resources}">${data.resources}</td>
            <td data-value="${data.aisc}">${isFinite(data.aisc) ? data.aisc.toFixed(0) : 'N/A'}</td>
            <td data-value="${data.revenue}">${isFinite(data.revenue) ? data.revenue.toFixed(2) : 'N/A'}</td>
            <td data-value="${data.profit}">${isFinite(data.profit) ? data.profit.toFixed(2) : 'N/A'}</td>
            <td><a href="${data.news}" target="_blank">Latest News</a></td>
            <td data-value="${data.evPerOz}">${isFinite(data.evPerOz) ? data.evPerOz.toFixed(2) : 'N/A'}</td>
            <td data-value="${data.marketCapPerOz}">${isFinite(data.marketCapPerOz) ? data.marketCapPerOz.toFixed(2) : 'N/A'}</td>
            <span class="tooltiptext" id="tooltip-${data.ticker}"></span>
        `;
        tbody.appendChild(row);
    });

    logStatus('Table populated, ranking...');
    updateRanking();
}

function computeRanks(companies, metricKey, higherBetter) {
    const validCompanies = companies.filter(c => !isNaN(c[metricKey]));
    if (validCompanies.length === 0) return {};
    const sorted = [...validCompanies].sort((a, b) => higherBetter ? b[metricKey] - a[metricKey] : a[metricKey] - b[metricKey]);
    const scoreMap = {};
    let currentRank = 1;
    let currentGroup = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i][metricKey] === sorted[i-1][metricKey]) {
            currentGroup.push(sorted[i]);
        } else {
            const groupSize = currentGroup.length;
            const sumRanks = (currentRank * groupSize) + (groupSize * (groupSize - 1)) / 2;
            const avgRank = sumRanks / groupSize;
            currentGroup.forEach(c => scoreMap[c.ticker] = (validCompanies.length + 1 - avgRank) / validCompanies.length);
            currentRank += groupSize;
            currentGroup = [sorted[i]];
        }
    }
    const groupSize = currentGroup.length;
    const sumRanks = (currentRank * groupSize) + (groupSize * (groupSize - 1)) / 2;
    const avgRank = sumRanks / groupSize;
    currentGroup.forEach(c => scoreMap[c.ticker] = (validCompanies.length + 1 - avgRank) / validCompanies.length);
    return scoreMap;
}

function updateRanking() {
    const rows = Array.from(table.tBodies[0].getElementsByTagName('tr'));
    const metrics = ['marketCap', 'ev' /* Add more metrics */];
    const weights = {};
    metrics.forEach(key => {
        weights[key] = { value: parseFloat(sliders[key].slider.value) / 100, higherBetter: sliders[key].dir.value === 'higher' };
    });

    const allData = rows.map(row => ({
        ticker: row.cells[1].textContent,
        marketCap: parseFloat(row.cells[3].getAttribute('data-value')) || NaN,
        ev: parseFloat(row.cells[4].getAttribute('data-value')) || NaN,
        // Add more metrics
    }));

    const scoreMaps = {};
    metrics.forEach(key => scoreMaps[key] = computeRanks(allData, key, weights[key].higherBetter));

    rows.forEach(row => {
        const ticker = row.cells[1].textContent;
        let score = 0;
        let tooltipText = `${row.cells[0].textContent} Score Breakdown:<br>`;
        metrics.forEach(key => {
            const metricValue = parseFloat(row.cells[metrics.indexOf(key) + 3].getAttribute('data-value'));
            const metricScore = !isNaN(metricValue) && scoreMaps[key][ticker] ? scoreMaps[key][ticker] : 0.5;
            const contribution = weights[key].value * metricScore;
            score += contribution;
            tooltipText += `${key}: ${metricScore.toFixed(2)} * ${weights[key].value.toFixed(1)} = ${contribution.toFixed(2)}<br>`;
        });
        row.dataset.score = score;
        document.getElementById(`tooltip-${ticker}`).innerHTML = tooltipText;
    });

    const sortedRows = rows.sort((a, b) => parseFloat(b.dataset.score) - parseFloat(a.dataset.score));
    requestAnimationFrame(() => {
        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
        sortedRows.forEach(row => tbody.appendChild(row));
    });
    logStatus('Ranking updated');
}

Object.entries(sliders).forEach(([key, { slider, valueSpan, dir }]) => {
    const updateValue = () => {
        const multiplier = (parseFloat(slider.value) / 100).toFixed(1);
        valueSpan.textContent = `${multiplier}x`;
        updateRanking();
    };
    slider.addEventListener('input', updateValue);
    dir.addEventListener('change', updateRanking);
    updateValue();
});

searchInput.addEventListener('input', () => {
    const filter = searchInput.value.toLowerCase();
    Array.from(table.tBodies[0].getElementsByTagName('tr')).forEach(row => {
        const companyName = row.cells[0].textContent.toLowerCase();
        row.style.display = companyName.includes(filter) ? '' : 'none';
    });
});

populateTable();