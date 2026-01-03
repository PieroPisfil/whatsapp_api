FROM node:20-slim

# ---- dependencias sistema para puppeteer ----
RUN apt-get update && apt-get install -y \
  chromium \
  ca-certificates \
  fonts-liberation \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libxss1 \
  libnss3 \
  libasound2 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  fonts-ipafont-gothic \
  fonts-wqy-zenhei \
  fonts-thai-tlwg \
  fonts-kacst \
  fonts-freefont-ttf \
  --no-install-recommends && \
  rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# ---- copiar package.json primero (cache) ----
COPY package*.json ./

# ---- instalar dependencias UNA sola vez ----
RUN npm install --omit=dev

# ---- copiar código ----
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
