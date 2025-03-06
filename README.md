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
cd mining-data-project

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
Purpose: Extracts mining data (e.g., mineral resources) from web pages and PDFs.

Usage:

bash
node populate_mining_data.js
Output: Updates companies table and logs to mining_population_log.txt.

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

