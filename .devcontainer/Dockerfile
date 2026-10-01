# Development container (and Pylot devbox image) for navvi.
#
# The Playwright image ships Node (22 or later) and the browsers for exactly
# the pinned `playwright` version, so nothing is downloaded on install. The tag
# must equal the `playwright` pin in package.json; scripts/check-image-pins.mjs
# fails CI when they disagree.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# better-sqlite3 (via camoufox-js) compiles with node-gyp.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Use the image's Chromium; skip the Camoufox and Playwright downloads.
ENV NAVVI_BROWSER=chromium \
    NAVVI_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /workspaces/navvi
