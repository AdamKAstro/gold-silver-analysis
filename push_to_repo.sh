#!/bin/bash

# Navigate to repo
cd ~/gold-silver-analysis

# Check status
echo "Checking status..."
git status

# Stage all changes
echo "Staging all files..."
git add .

# Commit changes
echo "Committing changes..."
git commit -m "Updated verify_prices.js with toggle for Yahoo+TradingView or all sources, added test_data_fetch.js and test_delays.js, updated JSONs and logs"

# Pull remote changes
echo "Pulling from origin/main..."
git pull origin main

# Push to GitHub
echo "Pushing to origin/main..."
git push origin main

# Confirmation
echo "Pushed to GitHub. Check https://github.com/AdamKAstro/gold-silver-analysis"
