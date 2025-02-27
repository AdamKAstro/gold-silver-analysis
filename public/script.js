const tbody = document.getElementById('miningTableBody');
const table = document.getElementById('miningTable');
const searchInput = document.getElementById('searchInput');
const statusLog = document.getElementById('statusLog');
const spinner = document.getElementById('spinner');
const sliders = {
    marketCap: { slider: document.getElementById('marketCapSlider'), valueSpan: document.getElementById('marketCapValue'), dir: document.getElementById('marketCapDir') },
    ev: { slider: document.getElementById('evSlider'), valueSpan: document.getElementById('evValue'), dir: document.getElementById('evDir') }
};

function logStatus(message) {
    statusLog.innerHTML += `<div>${new Date().toLocaleTimeString()}: ${message}</div>`;
    statusLog.scrollTop = statusLog.scrollHeight;
}

async function fetchAllData() {
    try {
        const res = await fetch('/api/data');
        if (!res.ok) throw new Error(`Failed to fetch data: ${res.statusText}`);
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

    tbody.innerHTML = '';
    allData.forEach(data => {
        const row = document.createElement('tr');
        row.classList.add('tooltip');
        row.innerHTML = `
            <td>${data.name || 'N/A'}</td>
            <td>${data.tsx_code || 'N/A'}</td>
            <td data-value="${data.stock_price || 0}">${data.stock_price ? data.stock_price.toFixed(2) : 'N/A'}</td>
            <td data-value="${data.market_cap_cad || 0}">${data.market_cap_cad ? (data.market_cap_cad / 1e9).toFixed(2) + 'B' : 'N/A'}</td>
            <td data-value="${data.enterprise_value_cad || 0}">${data.enterprise_value_cad ? (data.enterprise_value_cad / 1e9).toFixed(2) + 'B' : 'N/A'}</td>
            <td data-value="${data.reserves_au_moz || 0}">${data.reserves_au_moz ? data.reserves_au_moz.toFixed(2) : 'N/A'}</td>
            <td data-value="${data.resources_au_moz || 0}">${data.resources_au_moz ? data.resources_au_moz.toFixed(2) : 'N/A'}</td>
            <td data-value="${data.aisc_last_year_value || 0}">${data.aisc_last_year_value ? data.aisc_last_year_value.toFixed(0) : 'N/A'}</td>
            <td data-value="${data.revenue_cad || 0}">${data.revenue_cad ? (data.revenue_cad / 1e9).toFixed(2) + 'B' : 'N/A'}</td>
            <td data-value="${data.net_income_cad || 0}">${data.net_income_cad ? (data.net_income_cad / 1e9).toFixed(2) + 'B' : 'N/A'}</td>
            <td><a href="${data.news_link || '#'}" target="_blank">Latest News</a></td>
            <td data-value="${data.enterprise_value_cad / data.resources_au_moz || 0}">${data.enterprise_value_cad && data.resources_au_moz ? (data.enterprise_value_cad / data.resources_au_moz / 1e6).toFixed(2) : 'N/A'}</td>
            <td data-value="${data.market_cap_cad / data.resources_au_moz || 0}">${data.market_cap_cad && data.resources_au_moz ? (data.market_cap_cad / data.resources_au_moz / 1e6).toFixed(2) : 'N/A'}</td>
            <span class="tooltiptext" id="tooltip-${data.tsx_code || 'unknown'}"></span>
        `;
        tbody.appendChild(row);
    });

    logStatus('Table populated, ranking...');
    updateRanking();
}

function computeRanks(companies, metricKey, higherBetter) {
    const validCompanies = companies.filter(c => c[metricKey] !== null && !isNaN(c[metricKey]));
    if (validCompanies.length === 0) return {};
    const sorted = [...validCompanies].sort((a, b) => higherBetter ? b[metricKey] - a[metricKey] : a[metricKey] - b[metricKey]);
    const scoreMap = {};
    let currentRank = 1;
    let currentGroup = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i][metricKey] === sorted[i - 1][metricKey]) {
            currentGroup.push(sorted[i]);
        } else {
            const groupSize = currentGroup.length;
            const avgRank = currentRank + (groupSize - 1) / 2;
            currentGroup.forEach(c => scoreMap[c.tsx_code] = (validCompanies.length - avgRank + 1) / validCompanies.length);
            currentRank += groupSize;
            currentGroup = [sorted[i]];
        }
    }
    const groupSize = currentGroup.length;
    const avgRank = currentRank + (groupSize - 1) / 2;
    currentGroup.forEach(c => scoreMap[c.tsx_code] = (validCompanies.length - avgRank + 1) / validCompanies.length);
    return scoreMap;
}

function updateRanking() {
    const rows = Array.from(tbody.getElementsByTagName('tr'));
    const metrics = ['market_cap_cad', 'enterprise_value_cad'];
    const weights = {};
    metrics.forEach(key => {
        const sliderKey = key === 'market_cap_cad' ? 'marketCap' : 'ev';
        weights[key] = {
            value: parseFloat(sliders[sliderKey].slider.value) / 100,
            higherBetter: sliders[sliderKey].dir.value === 'higher'
        };
    });

    const allData = rows.map(row => ({
        tsx_code: row.cells[1].textContent,
        market_cap_cad: parseFloat(row.cells[3].getAttribute('data-value')) || 0,
        enterprise_value_cad: parseFloat(row.cells[4].getAttribute('data-value')) || 0
    }));

    const scoreMaps = {};
    metrics.forEach(key => scoreMaps[key] = computeRanks(allData, key, weights[key].higherBetter));

    rows.forEach(row => {
        const ticker = row.cells[1].textContent;
        let score = 0;
        let tooltipText = `${row.cells[0].textContent} Score Breakdown:<br>`;
        metrics.forEach(key => {
            const metricValue = parseFloat(row.cells[metrics.indexOf(key) + 3].getAttribute('data-value'));
            const metricScore = scoreMaps[key][ticker] || 0.5; // Default to 0.5 if no rank
            const contribution = weights[key].value * metricScore;
            score += contribution;
            tooltipText += `${key}: ${metricScore.toFixed(2)} * ${weights[key].value.toFixed(1)} = ${contribution.toFixed(2)}<br>`;
        });
        row.dataset.score = score;
        document.getElementById(`tooltip-${ticker}`).innerHTML = tooltipText;
    });

    const sortedRows = rows.sort((a, b) => parseFloat(b.dataset.score) - parseFloat(a.dataset.score));
    requestAnimationFrame(() => {
        tbody.innerHTML = '';
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
    Array.from(tbody.getElementsByTagName('tr')).forEach(row => {
        const companyName = row.cells[0].textContent.toLowerCase();
        row.style.display = companyName.includes(filter) ? '' : 'none';
    });
});

document.addEventListener('DOMContentLoaded', populateTable);