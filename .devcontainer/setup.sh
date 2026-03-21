#!/bin/bash
set -e

# Install Chromium + Playwright deps
sudo env PATH="$PATH" npx playwright install-deps chromium
npx playwright install chromium

# Install playwright-core for CDP scripting
npm install playwright-core

# Install PinchTab
curl -fsSL https://pinchtab.com/install.sh | bash

echo ""
echo "Navvi devcontainer ready."
echo "  VNC:      http://localhost:6080 (password: navvi)"
echo "  CDP:      port 9222 (via launch-chrome.sh)"
echo "  PinchTab: port 9867 (via launch-pinchtab.sh)"
