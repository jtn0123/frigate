#!/usr/bin/env bash
# Prepare image-owned paths once at build time, never chown mounted user data.
set -o errexit -o nounset -o pipefail

runtime_dirs=(
    /run
    /config
    /media/frigate
    /home/frigate
    /etc/letsencrypt
    /usr/local/nginx/conf
    /usr/local/nginx/logs
    /usr/local/nginx/client_body_temp
    /usr/local/nginx/proxy_temp
    /usr/local/nginx/fastcgi_temp
    /usr/local/nginx/uwsgi_temp
    /usr/local/nginx/scgi_temp
)
mkdir -p "${runtime_dirs[@]}"
chown -R 65534:65534 "${runtime_dirs[@]}"

# nginx inherits the container user; root-run variant images keep their config.
sed -i '/^user root;/d' /usr/local/nginx/conf/nginx.conf

# s6 must remain unprivileged even when the container manager allows setuid.
find /package -type f -perm /6000 -exec chmod a-s {} +
