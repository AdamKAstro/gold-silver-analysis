const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { parse } = require('csv-parse/sync');

const CSV_FILE = 'public/data/companies.csv';

const db = new sqlite3.Database('./mining_companies.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to database for company generation.');
});

async function generateCompanies() {
    try {
        const csvData = await fs.readFile(CSV_FILE, 'utf8');
        const cleanedCsvData = csvData.replace(/^\ufeff/, '');
        console.log('CSV Header:', cleanedCsvData.split('\n')[0]);
        const companies = parse(cleanedCsvData, { columns: true, skip_empty_lines: true, trim: true });
        console.log('Parsed Companies Count:', companies.length);

        for (const company of companies) {
            const ticker = company.TICKER || company['﻿TICKER'];
            const name = company.NAME || 'Unknown Name';
            console.log(`Processing: ${ticker}, ${name}`);

            if (!ticker) {
                console.error('Skipping: No valid TICKER found for row:', company);
                continue;
            }

            const companyName = name.toLowerCase().replace(/\s+/g, '');
            const defaultWebsite = `https://www.${companyName}.com`;

            const companyData = {
                tsx_code: ticker,
                name,
                description: "A Canadian mining company involved in gold or silver.",
                stock_price: 0,
                stock_price_currency: "CAD",
                last_updated: new Date().toISOString(),
                number_of_shares: 0,
                market_cap_value: 0,
                market_cap_currency: "CAD",
                cash_value: 0,
                cash_currency: "USD",
                debt_value: 0,
                debt_currency: "USD",
                enterprise_value_value: 0,
                enterprise_value_currency: "CAD",
                revenue_value: 0,
                revenue_currency: "USD",
                net_income_value: 0,
                net_income_currency: "USD",
                reserves_gold_moz: 0,
                reserves_silver_moz: 0,
                resources_gold_moz: 0,
                resources_silver_moz: 0,
                resources_copper_mlb: 0,
                resources_zinc_mlb: 0,
                resources_manganese_mt: 0,
                potential_gold_moz: 0,
                potential_silver_moz: 0,
                reserves_precious_au_eq_koz: 0,
                resources_precious_au_eq_koz: 0,
                potential_precious_au_eq_koz: 0,
                mineable_precious_au_eq_moz: 0,
                mineable_non_precious_au_eq_moz: 0,
                mineable_all_au_eq_moz: 0,
                percentage_in_gold: 0,
                percentage_in_silver: 0,
                production_total_au_eq_koz: 0,
                aisc_last_year_value: 0,
                aisc_last_year_currency: "USD",
                news_link: `https://www.miningfeeds.com/company/${ticker.toLowerCase().replace('.to', '').replace('.v', '').replace('.cn', '')}/`,
                reserve_boost_factor: 3,
                resources_detailed: JSON.stringify([]),
                mining_summary: JSON.stringify({}),
                company_website: defaultWebsite,
                resources_gold_moz_from_overview: 0,
                resources_silver_moz_from_overview: 0,
                last_updated_overview: null,
                pdf_sources: JSON.stringify([]),
                sources: JSON.stringify([])
            };

            const fields = Object.keys(companyData);
            const placeholders = fields.map(() => '?').join(', ');
            const sql = `INSERT OR REPLACE INTO companies (${fields.join(', ')}) VALUES (${placeholders})`;
            await new Promise((resolve, reject) => {
                db.run(sql, Object.values(companyData), function(err) {
                    if (err) {
                        console.error(`Error inserting ${ticker}: ${err.message}`);
                        reject(err);
                    } else {
                        console.log(`Inserted/Updated ${ticker} into database`);
                        resolve();
                    }
                });
            });
        }
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        db.close();
    }
}

generateCompanies();