CREATE TABLE companies (
    company_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tsx_code TEXT UNIQUE,
    description TEXT,
    stock_price REAL,              -- In CAD for TSX listings
    stock_price_currency TEXT,     -- Original currency (e.g., 'CAD')
    last_updated TEXT,             -- ISO timestamp, e.g., '2025-02-26T19:24:00Z'
    number_of_shares INTEGER,
    number_of_shares_diluted INTEGER,
    options_in_money INTEGER,
    revenue_from_options_value REAL,
    revenue_from_options_currency TEXT,
    cash_value REAL,
    cash_currency TEXT,
    cash_cad REAL,                 -- Converted to CAD
    investments_value REAL,
    investments_currency TEXT,
    liabilities_value REAL,
    liabilities_currency TEXT,
    debt_value REAL,               -- Total debt
    debt_currency TEXT,
    debt_cad REAL,                 -- Converted to CAD
    market_cap_value REAL,
    market_cap_currency TEXT,
    market_cap_cad REAL,           -- Converted to CAD
    enterprise_value_value REAL,
    enterprise_value_currency TEXT,
    enterprise_value_cad REAL,     -- Converted to CAD
    net_financial_assets_value REAL,
    net_financial_assets_currency TEXT,
    revenue_value REAL,
    revenue_currency TEXT,
    revenue_cad REAL,              -- Converted to CAD
    net_income_value REAL,
    net_income_currency TEXT,
    net_income_cad REAL,           -- Converted to CAD
    status TEXT,                   -- e.g., 'Producer'
    minerals_of_interest TEXT,     -- e.g., 'Silver, Gold'
    percent_gold REAL,             -- % of revenue from gold
    percent_silver REAL,           -- % of revenue from silver
    headquarters TEXT,
    reserves_au_moz REAL,          -- Gold reserves in million ounces
    resources_au_moz REAL,         -- Gold resources in million ounces
    production_precious_au_eq_koz REAL,  -- Precious metal production in AuEq koz
    production_non_precious_au_eq_koz REAL, -- Non-precious in AuEq koz
    production_total_au_eq_koz REAL, -- Total production in AuEq koz
    future_production_au_eq_koz REAL,
    reserve_life_years REAL,
    aisc_last_quarter_value REAL,
    aisc_last_quarter_currency TEXT, -- Typically USD/oz
    aisc_last_year_value REAL,
    aisc_last_year_currency TEXT,
    aisc_future_value REAL,
    aisc_future_currency TEXT,
    free_cash_flow_value REAL,
    free_cash_flow_currency TEXT,
    free_cash_flow_cad REAL,       -- Converted to CAD
    news_link TEXT
);