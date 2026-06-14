FROM node:20-alpine AS base

# Install Tesseract + language packs and build tools
RUN apk add --no-cache \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    vips-dev \
    python3 \
    make \
    g++

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

COPY . .

EXPOSE 3001

CMD ["node", "src/app.js"]
