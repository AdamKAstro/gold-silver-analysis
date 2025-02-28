CREATE TABLE exchange_rates (
    currency TEXT PRIMARY KEY,     -- e.g., 'USD', 'AUD'
    rate_to_cad REAL,             -- Exchange rate to CAD
    last_updated TEXT             -- ISO timestamp
);