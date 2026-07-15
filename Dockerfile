# Use Apify's official Node.js + Playwright + Chrome base image (Node 18)
FROM apify/actor-node-playwright-chrome:18

# Run as root to avoid permission issues with Playwright browsers
USER root

# Copy package.json first to leverage Docker cache for npm install
COPY package.json ./

# Install production dependencies only (faster and smaller image)
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the source code (main.js, interceptor.js, etc.)
COPY . ./

# Run the main.js file from the root directory (NOT src/main.js)
CMD ["node", "main.js"]FROM apify/actor-node-playwright-chrome:18

USER root

COPY package.json ./

RUN npm install --omit=dev

COPY . ./

CMD ["node", "src/main.js"]
