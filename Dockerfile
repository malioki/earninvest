# Family finance bot (src/family.ts): Telegram bot, web pages, scheduler.
# Secrets come from .env at run time and data/ is mounted from the host —
# neither is ever baked into the image.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
# The scheduler and "today" use local time: reminders at 19:00 must be Chisinau's 19:00.
RUN apk add --no-cache tzdata
ENV TZ=Europe/Chisinau NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
CMD ["node", "dist/family.js"]
