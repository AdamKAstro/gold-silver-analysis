# Mining Data Collection and Analysis Project

## Overview
This project automates the collection, processing, and analysis of data for mining companies, with a focus on those listed on the Junior Mining Network (JMN). It gathers data from multiple sources, including company websites, financial APIs (Yahoo Finance, Alpha Vantage), and PDF reports (e.g., annual reports, NI 43-101 technical reports). The data is stored in an SQLite database (`mining_companies.db`) for querying and analysis.

### Purpose
The primary goals are:
- To collect stock prices, mineral resource estimates, and financial data (e.g., cash, debt, revenue) for mining companies.
- To validate data sources (e.g., URLs) and cross-verify data for accuracy.
- To provide a maintainable system for ongoing data updates and future enhancements.

### Key Features
- **URL Management**: Generates and validates URLs for data sources like JMN, Yahoo Finance, and company homepages.
- **Data Extraction**: Scrapes mining data from web pages and extracts information from PDFs.
- **Financial Data**: Integrates with financial APIs for real-time data.
- **Database Storage**: Organizes data in a structured SQLite database.
- **Error Handling**: Logs errors and discrepancies for troubleshooting.

## Project Structure
Here’s how the project is organized:
- **Scripts**:
  - `populate_company_urls.js`: Generates and validates URLs for data sources.
  - `populate_mining_data.js`: Extracts mining data from web pages and PDFs.
  - `populate_financials.js`: Fetches financial data via APIs.
- **Configuration**:
  - `package.json`: Lists Node.js dependencies (e.g., `puppeteer`, `pdf-parse`, `yahoo-finance2`, `sqlite3`).
- **Database**:
  - `mining_companies.db`: SQLite database storing all collected data.
- **PDFs** (in `public/data/PDFs/`):
  - `WGX_TO_AnnualReport.pdf`: Annual report for the "WGX" company.
  - `WGX_TO_NI43101BHOTechnicalReport.pdf`, `WGX_TO_NI43101CGOTechnicalReport.pdf`, etc.: NI 43-101 technical reports for various "WGX" projects or sites.
- **Logs**:
  - `mining_population_log.txt`, `url_population_log.txt`, `financial_population_log.txt`: Logs script execution and errors.

## Setup Instructions
Follow these steps to set up the project locally:

### 1. Clone the Repository
```bash

git clone https://github.com/AdamKAstro/gold-silver-analysis.git

Update Repo with local copy :
git add .
git commit -m "Update Notes, README, database, logs, and add new files"
git push origin main
git status
---

# Clone the repo (only needed once, skip if already cloned)
git clone https://github.com/AdamKAstro/gold-silver-analysis.git
cd gold-silver-analysis  
# Pull the latest changes (run anytime after cloning)
git pull origin main
# Check the status to confirm everything’s in sync
git status

---
 If You Have Uncommitted Local Changes
Option A: Commit your changes first
git add .
git commit -m "Save local changes before pulling"
git pull origin main

Option B: Stash your changes temporarily
git stash
git pull origin main
git stash pop  # Brings your changes back





--------------
## Running the Scripts

Run each script to perform its task. Ensure dependencies are installed and the database is set up.
Populate Company URLs
Purpose: Generates and validates URLs for JMN, Yahoo Finance, and company homepages.

Usage:

bash
node populate_company_urls.js

Output: Updates company_urls table and logs issues to url_population_log.txt.
-----------

Populate Mining Data


npm install puppeteer-extra puppeteer-extra-plugin-stealth axios cheerio fs csv-parse sqlite3 pdf-parse yahoo-finance2 yargs
node populate_mining_data.js or with options (e.g., --update-stock-prices).




Stock prices only: node populate_mining_data.js --update-stock-prices

Mining data only: node populate_mining_data.js --update-mining-data

Everything: node populate_mining_data.js --update-all


-----------------
Populate Financials
Purpose: Fetches financial data (e.g., stock prices, cash) via APIs.

Usage:
node populate_financials.js
Output: Updates companies table and logs to financial_population_log.txt.


Data Sources
The project collects data from:
Junior Mining Network (JMN): Stock market data and company homepages (e.g., "aberdeeninternational.ca" from Image 5).

Yahoo Finance: Stock prices and financials via yahoo-finance2.

Alpha Vantage: Backup financial data via API.

PDFs: NI 43-101 technical reports and annual reports (e.g., WGX_TO_* files) for detailed mining data.

Database Schema
The SQLite database (mining_companies.db) includes:
companies Table
Stores company data.

Columns:
tsx_code (TEXT, PRIMARY KEY): Company ticker (e.g., "WGX").

name (TEXT): Company name.

stock_price (REAL): Current stock price.

resources_gold_moz (REAL): Gold resources in million ounces.

cash_value (REAL): Cash on hand.

debt_value (REAL): Total debt.

company_urls Table
Stores validated URLs.

Columns:
id (INTEGER, PRIMARY KEY, AUTOINCREMENT).

tsx_code (TEXT): Foreign key to companies.

url_type (TEXT): "jmn", "yahoo_finance", "homepage".

url (TEXT): The URL.

last_checked (TEXT): Timestamp of last validation.

url_verification_log Table
Logs URL validation failures.

Columns:
id (INTEGER, PRIMARY KEY, AUTOINCREMENT).

company_ticker (TEXT): Ticker.

url_type (TEXT): Type of URL.

attempted_url (TEXT): Failed URL.

status (TEXT): Failure reason.

timestamp (TEXT): When it failed.

Recreate Schema (if needed):

CREATE TABLE companies (
    tsx_code TEXT PRIMARY KEY,
    name TEXT,
    stock_price REAL DEFAULT 0,
    resources_gold_moz REAL DEFAULT 0,
    cash_value REAL DEFAULT 0,
    debt_value REAL DEFAULT 0
);

CREATE TABLE company_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tsx_code TEXT,
    url_type TEXT,
    url TEXT,
    last_checked TEXT,
    FOREIGN KEY (tsx_code) REFERENCES companies(tsx_code)
);

CREATE TABLE url_verification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_ticker TEXT,
    url_type TEXT,
    attempted_url TEXT,
    status TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

###table schemas

PROD+akiil@L2500595 MINGW64 ~/gold-silver-analysis (main)
$ sqlite3 mining_companies.db
SQLite version 3.49.1 2025-02-18 13:38:58
Enter ".help" for usage hints.
sqlite> .tables
companies             exchange_rates        url_verification_log
company_urls          successful_urls
sqlite> .schema company_urls
CREATE TABLE company_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tsx_code TEXT,
    url_type TEXT,
    url TEXT,
    last_checked TEXT,
    FOREIGN KEY (tsx_code) REFERENCES companies(tsx_code)
);
sqlite> SELECT * FROM company_urls LIMIT 20;
88|AAB.TO|yahoo_finance|https://finance.yahoo.com/quote/AAB.TO/|2025-03-05T06:55:19.850Z
89|AAB.TO|jmn|https://www.juniorminingnetwork.com/market-data/stock-quote/aberdeen-international.html|2025-03-05T06:55:19.854Z
90|AAG.V|yahoo_finance|https://finance.yahoo.com/quote/AAG.V/|2025-03-05T06:55:23.655Z
91|AAG.V|jmn|https://www.juniorminingnetwork.com/market-data/stock-quote/aftermath-silver.html|2025-03-05T06:55:23.659Z
92|AAN.V|yahoo_finance|https://finance.yahoo.com/quote/AAN.V/|2025-03-05T06:55:26.126Z
93|AAUC.TO|yahoo_finance|https://finance.yahoo.com/quote/AAUC.TO/|2025-03-05T06:55:31.251Z
94|AAUC.TO|jmn|https://www.juniorminingnetwork.com/market-data/stock-quote/allied-gold.html|2025-03-05T06:55:31.255Z
95|ABI.V|yahoo_finance|https://finance.yahoo.com/quote/ABI.V/|2025-03-05T06:55:36.037Z
96|ABI.V|jmn|https://www.juniorminingnetwork.com/market-data/stock-quote/abcourt-mines.html|2025-03-05T06:55:36.040Z
97|ABRA.TO|yahoo_finance|https://finance.yahoo.com/quote/ABRA.TO/|2025-03-05T06:55:39.892Z
98|ABRA.TO|jmn|https://www.juniorminingnetwork.com/market-data/stock-quote/abrasilver-resource.html|2025-03-05T06:55:39.895Z
99|ADY.V|yahoo_finance|https://finance.yahoo.com/quote/ADY.V/|2025-03-05T06:55:42.349Z
100|ADZ.V|yahoo_finance|https://finance.yahoo.com/quote/ADZ.V/|2025-03-05T06:55:47.425Z
101|ADZ.V|jmn|https://www.juniorminingnetwork.com/market-data/stock-quote/adamera-minerals.html|2025-03-05T06:55:47.431Z
102|AE.V|yahoo_finance|https://finance.yahoo.com/quote/AE.V/|2025-03-05T06:55:51.020Z
103|AE.V|jmn|https://www.juniorminingnetwork.com/market-data/stock-quote/american-eagle-gold.html|2025-03-05T06:55:51.025Z
104|AEM.TO|yahoo_finance|https://finance.yahoo.com/quote/AEM.TO/|2025-03-05T06:55:56.014Z
105|AEM.TO|jmn|https://www.juniorminingnetwork.com/market-data/stock-quote/agnico-eagle-mines.html|2025-03-05T06:55:56.017Z
106|AERO.V|yahoo_finance|https://finance.yahoo.com/quote/AERO.V/|2025-03-05T06:55:59.832Z
107|AERO.V|jmn|https://www.juniorminingnetwork.com/market-data/stock-quote/aero-energy.html|2025-03-05T06:55:59.835Z
sqlite> .schema companies
CREATE TABLE companies (
            company_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            tsx_code TEXT UNIQUE,
            description TEXT,
            stock_price REAL,
            stock_price_currency TEXT,
            last_updated TEXT,
            number_of_shares INTEGER,
            market_cap_value REAL,
            market_cap_currency TEXT,
            market_cap_cad REAL,
            cash_value REAL,
            cash_currency TEXT,
            cash_cad REAL,
            debt_value REAL,
            debt_currency TEXT,
            debt_cad REAL,
            enterprise_value_value REAL,
            enterprise_value_currency TEXT,
            enterprise_value_cad REAL,
            revenue_value REAL,
            revenue_currency TEXT,
            revenue_cad REAL,
            net_income_value REAL,
            net_income_currency TEXT,
            net_income_cad REAL,
            reserves_au_moz REAL,
            resources_au_moz REAL,
            production_total_au_eq_koz REAL,
            aisc_last_year_value REAL,
            aisc_last_year_currency TEXT,
            news_link TEXT
        , company_website TEXT, pdf_sources TEXT DEFAULT '[]', sources TEXT DEFAULT '[]', reserves_gold_moz REAL DEFAULT 0, reserves_silver_moz REAL DEFAULT 0, resources_gold_moz REAL DEFAULT 0, resources_silver_moz REAL DEFAULT 0, resources_copper_mlb REAL DEFAULT 0, resources_zinc_mlb REAL DEFAULT 0, resources_manganese_mt REAL DEFAULT 0, potential_gold_moz REAL DEFAULT 0, potential_silver_moz REAL DEFAULT 0, reserves_precious_au_eq_koz REAL DEFAULT 0, resources_precious_au_eq_koz REAL DEFAULT 0, potential_precious_au_eq_koz REAL DEFAULT 0, mineable_precious_au_eq_moz REAL DEFAULT 0, mineable_non_precious_au_eq_moz REAL DEFAULT 0, mineable_all_au_eq_moz REAL DEFAULT 0, percentage_in_gold REAL DEFAULT 0, percentage_in_silver REAL DEFAULT 0, reserve_boost_factor INTEGER DEFAULT 3, resources_detailed TEXT DEFAULT '[]', mining_summary TEXT DEFAULT '{}', last_updated_mining TEXT, resources_gold_moz_from_homepage REAL DEFAULT 0, resources_silver_moz_from_homepage REAL DEFAULT 0, last_updated_homepage TEXT);
sqlite> SELECT tsx_code, reserves_gold_moz, resources_gold_moz FROM companies LIMIT 10;
ABX.TO|0.0|0.0
TSX_CODE.TO|0.0|0.0
AAB.TO|0.0|0.0
AAG.V|0.0|0.0
AAN.V|0.0|0.0
AAUC.TO|0.0|0.0
ABI.V|0.0|0.0
ABRA.TO|0.0|0.0
ADY.V|0.0|0.0
ADZ.V|0.0|0.0
sqlite> .exit
