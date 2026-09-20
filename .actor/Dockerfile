# Navvi on Apify, Chromium image (the default build). The tag carries the
# Playwright version and must equal the `playwright` pin in package.json;
# scripts/check-image-pins.mjs fails CI when they disagree. Digest pinned.
FROM apify/actor-node-playwright-chrome:22-1.60.0@sha256:629fed68975c2f142f6e1b93321c24661f36362f683726f59d9028e289848fab

# The image ships the browsers: no Playwright or Camoufox download on install.
ENV NAVVI_BROWSER=chromium \
    NAVVI_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# better-sqlite3 (via camoufox-js) has no prebuild here and compiles with node-gyp.
# camoufox-js is installed only so its types resolve during the build; the prune below drops it.
USER root
RUN apt update \
    && apt install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && apt clean -y
USER myuser

COPY --chown=myuser package*.json ./
# npm runs the postinstall script during `npm ci`, so it has to be in place first.
COPY --chown=myuser scripts/postinstall.mjs ./scripts/postinstall.mjs

# Dev dependencies are needed for the TypeScript build, then pruned.
RUN npm --quiet set progress=false \
    && npm ci \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version

COPY --chown=myuser . ./

RUN npm run build:actor \
    && npm prune --omit=dev --omit=optional \
    && echo "Installed NPM packages:" && (npm list --omit=dev --all || true)

CMD ["npm", "start", "--silent"]
