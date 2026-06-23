# Zerun frontend: the cartoon arena UI.
FROM node:22-slim

WORKDIR /app
RUN npm install -g pnpm@11.0.8

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --ignore-scripts

COPY . .

# The browser reaches the backend through this URL. Next.js inlines public env
# at build time, so it has to be set before the build.
ARG NEXT_PUBLIC_API_URL=http://localhost:8787
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN node_modules/.bin/next build

EXPOSE 3000

CMD ["node_modules/.bin/next", "start"]
