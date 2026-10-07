# Playwright-ready image (browsers preinstalled; matches playwright@1.40.0 in package.json)
FROM mcr.microsoft.com/playwright:v1.40.0-focal

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Hugging Face Spaces serves on 7860
EXPOSE 7860
ENV NODE_ENV=production

CMD ["node", "index.js"]
