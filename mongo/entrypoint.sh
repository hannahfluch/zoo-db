#!/bin/bash
set -euo pipefail
# Persist the internal replica-set authentication key independently of the image.
if [ ! -s /data/configdb/zoo-keyfile ]; then
  umask 077
  openssl rand -base64 756 > /data/configdb/zoo-keyfile
fi
chown mongodb:mongodb /data/configdb/zoo-keyfile
chmod 400 /data/configdb/zoo-keyfile
exec /usr/local/bin/docker-entrypoint.sh "$@"
