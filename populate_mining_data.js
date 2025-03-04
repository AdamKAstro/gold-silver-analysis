const fs = require('fs').promises;
const { parse } = require('csv-parse/sync');

// **Configuration**
const CSV_FILE = 'public/data/companies.csv'; // Your CSV file
const LOG_FILE = 'mining_population_log.txt'; // Log file
const TEST_TICKERS = ['AAB.TO', 'AAG.V', 'AAN.V']; // Test tickers

// **Helper: Log messages to console and file**
async function log(message) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;
  console.log(formattedMessage);
  await fs.appendFile(LOG_FILE, formattedMessage + '\n');
}

// **Main Execution**
async function main() {
  // Check if CSV file exists
  try {
    await fs.access(CSV_FILE);
  } catch {
    await log(`Error: ${CSV_FILE} not found. Please ensure it exists.`);
    process.exit(1);
  }

  // Read and parse CSV with BOM handling
  const csvData = await fs.readFile(CSV_FILE, 'utf8');
  let companies;
  try {
    companies = parse(csvData, {
      columns: true,
      skip_empty_lines: true,
      bom: true // Automatically handle BOM
    });
    await log(`Parsed ${companies.length} companies from CSV`);
  } catch (e) {
    await log(`Error parsing CSV: ${e.message}`);
    process.exit(1);
  }

  // Log sample rows to verify parsing
  await log('Sample rows:');
  companies.slice(0, 3).forEach((row, index) => {
    await log(`Row ${index + 1}: ${JSON.stringify(row)}`);
  });

  // Validate column names
  const expectedColumns = ['TICKER', 'NAME', 'NAMEALT'];
  const parsedColumns = companies.length > 0 ? Object.keys(companies[0]) : [];
  const missingColumns = expectedColumns.filter(col => !parsedColumns.includes(col));
  if (missingColumns.length > 0) {
    await log(`Error: Missing expected columns in CSV: ${missingColumns.join(', ')}`);
    process.exit(1);
  }
  await log(`Confirmed columns: ${parsedColumns.join(', ')}`);

  // Filter for test tickers
  const testCompanies = companies.filter(c => TEST_TICKERS.includes(c.TICKER));
  if (testCompanies.length === 0) {
    const availableTickers = companies.map(c => c.TICKER).join(', ');
    await log(`No test tickers found in CSV. Expected: ${TEST_TICKERS.join(', ')}. Available: ${availableTickers}`);
    process.exit(1);
  }

  await log(`Found ${testCompanies.length} test tickers:`);
  testCompanies.forEach(c => {
    await log(`- ${c.TICKER} (${c.NAME}${c.NAMEALT ? ` / ${c.NAMEALT}` : ''})`);
  });

  // Placeholder for further processing (e.g., scraping)
  for (const { TICKER: ticker, NAME: name, NAMEALT: nameAlt } of testCompanies) {
    await log(`Processing ${ticker} (${name}${nameAlt ? ` / ${nameAlt}` : ''})`);
    // Add your scraping logic here if needed
  }

  await log('All done! Ready for further processing.');
}

// **Run the script**
main().catch(async err => {
  await log(`Main execution failed: ${err.message}`);
  process.exit(1);
});
