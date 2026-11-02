#!/bin/sh
set -eu

# Run Compose from the project directory, even when invoked elsewhere.
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

printf '%s\n' 'Resetting the zoo database: all stored data will be deleted.'
docker compose config --quiet
docker compose build db
docker compose down --volumes
docker compose up -d --wait db
printf '%s\n' 'Zoo database recreated with the current schema and sample data.'
