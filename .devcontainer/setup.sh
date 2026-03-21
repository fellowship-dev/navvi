#!/bin/bash
set -e

# Install Chromium + Playwright deps
sudo env PATH="$PATH" npx playwright install-deps chromium
npx playwright install chromium

# Install playwright-core for CDP scripting
npm install playwright-core

# Install PinchTab
curl -fsSL https://pinchtab.com/install.sh | bash

# Install gopass (credential manager)
GOPASS_VERSION="1.15.14"
ARCH=$(dpkg --print-architecture 2>/dev/null || echo "amd64")
curl -fsSL "https://github.com/gopasspw/gopass/releases/download/v${GOPASS_VERSION}/gopass_${GOPASS_VERSION}_linux_${ARCH}.deb" -o /tmp/gopass.deb
sudo dpkg -i /tmp/gopass.deb
rm /tmp/gopass.deb

# Import GPG key from Codespace secret (if available)
if [ -n "${GPG_PRIVATE_KEY:-}" ]; then
  echo "$GPG_PRIVATE_KEY" | gpg --batch --import 2>/dev/null
  GPG_ID=$(gpg --list-secret-keys --keyid-format long 2>/dev/null | grep sec | head -1 | awk '{print $2}' | cut -d/ -f2)
  if [ -n "$GPG_ID" ]; then
    # Trust the key ultimately
    echo "${GPG_ID}:6:" | gpg --import-ownertrust 2>/dev/null
    # Init gopass if not already
    if [ ! -d "$HOME/.local/share/gopass/stores/root" ]; then
      gopass init --path "$HOME/.local/share/gopass/stores/root" "$GPG_ID" 2>/dev/null
    fi
    echo "  Gopass:   ready (GPG key imported)"
  fi
else
  echo "  Gopass:   installed (set GPG_PRIVATE_KEY secret to enable)"
fi

echo ""
echo "Navvi devcontainer ready."
echo "  VNC:      http://localhost:6080 (password: navvi)"
echo "  CDP:      port 9222 (via launch-chrome.sh)"
echo "  PinchTab: port 9867 (via launch-pinchtab.sh)"
