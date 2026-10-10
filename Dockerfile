FROM node:20-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

# System libs for @napi-rs/canvas text rendering on Alpine
RUN apk add --no-cache \
    fontconfig \
    ttf-dejavu \
    && rm -rf /var/cache/apk/*

COPY package*.json ./
# Use npm install (not npm ci) so a temporarily out-of-sync lockfile does not fail the build
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
