#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this installer as root on the Ubuntu application server.' >&2
  exit 1
fi
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if ! /usr/bin/python3 -c 'import maxminddb' 2>/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-maxminddb
fi
for account in fantasytales-logwatch fantasytales-geodb; do
  if ! id "$account" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$account"
  fi
done

# Nginx initially created the custom log as root:root; use the same read group
# as Ubuntu's existing /etc/logrotate.d/nginx (create 0640 www-data adm).
chgrp adm /var/log/nginx/access.log /var/log/nginx/fantasytales-access.log
chmod 0640 /var/log/nginx/access.log /var/log/nginx/fantasytales-access.log
runuser -u fantasytales-logwatch -G adm -- /usr/bin/python3 -c \
  'for path in ("/var/log/nginx/access.log", "/var/log/nginx/fantasytales-access.log"): open(path).close()'

install -d -m 0755 /usr/local/libexec
install -m 0755 "$SOURCE_DIR/logwatch.py" /usr/local/bin/fantasytales-logwatch
install -m 0755 "$SOURCE_DIR/update-country.py" /usr/local/libexec/fantasytales-update-country
for unit in fantasytales-logwatch.service fantasytales-geodb.service fantasytales-geodb.timer; do
  install -m 0644 "$SOURCE_DIR/$unit" "/etc/systemd/system/$unit"
done
systemd-analyze verify /etc/systemd/system/fantasytales-logwatch.service \
  /etc/systemd/system/fantasytales-geodb.service /etc/systemd/system/fantasytales-geodb.timer
systemctl daemon-reload
# Finish the initial database download before starting the live viewer.
systemctl start fantasytales-geodb.service
systemctl enable fantasytales-logwatch.service fantasytales-geodb.timer
systemctl reset-failed fantasytales-logwatch.service
systemctl restart fantasytales-logwatch.service fantasytales-geodb.timer
sleep 1
systemctl is-active fantasytales-logwatch.service fantasytales-geodb.timer
