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