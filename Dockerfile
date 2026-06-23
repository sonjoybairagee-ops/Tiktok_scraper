FROM apify/actor-node-playwright-chrome:18

USER root

COPY package.json ./

RUN npm install --omit=dev

COPY . ./

CMD ["node", "src/main.js"]