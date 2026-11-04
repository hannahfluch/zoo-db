#!/bin/sh
set -eu

# Run Compose from the project directory, even when invoked elsewhere.
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

printf '%s\n' 'Resetting PostgreSQL and MongoDB: all stored data in both databases will be deleted.'
docker compose config --quiet
docker compose build db
docker compose down --volumes
docker compose up -d --wait
printf '%s\n' 'PostgreSQL recreated with the current schema and sample data; MongoDB started empty.'
