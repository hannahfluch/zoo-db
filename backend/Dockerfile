FROM grafana/k6:1.4.0 AS k6
FROM oven/bun:1.3.13
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
