FROM node:20-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Optional system libs for @napi-rs/canvas text rendering on Alpine
RUN apk add --no-cache \
    fontconfig \
    ttf-dejavu \
    && rm -rf /var/cache/apk/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
