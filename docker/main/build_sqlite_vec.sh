#!/bin/bash
set -euxo pipefail

# Keep transport restrictions consistent for every download in this stage.
download_https() {
    curl --proto '=https' --proto-redir '=https' -fsSL "$@"
}


SQLITE_VEC_VERSION="0.1.9"

source /etc/os-release

if [[ "$VERSION_ID" == "12" ]]; then
    sed -i '/^Types:/s/deb/& deb-src/' /etc/apt/sources.list.d/debian.sources
else
    cp /etc/apt/sources.list /etc/apt/sources.list.d/sources-src.list
    sed -i 's|deb http|deb-src http|g' /etc/apt/sources.list.d/sources-src.list
fi

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl
apt-get -yqq build-dep sqlite3 gettext git

mkdir /tmp/sqlite_vec
# Grab the sqlite_vec source code.
download_https --remote-name https://github.com/asg017/sqlite-vec/archive/refs/tags/v${SQLITE_VEC_VERSION}.tar.gz
tar -zxf v${SQLITE_VEC_VERSION}.tar.gz -C /tmp/sqlite_vec

cd /tmp/sqlite_vec/sqlite-vec-${SQLITE_VEC_VERSION}

mkdir -p vendor
download_https --output sqlite-amalgamation.zip https://www.sqlite.org/2024/sqlite-amalgamation-3450300.zip
unzip sqlite-amalgamation.zip
mv sqlite-amalgamation-3450300/* vendor/
rmdir sqlite-amalgamation-3450300
rm sqlite-amalgamation.zip

# build loadable module
make loadable

# install it
cp dist/vec0.* /usr/local/lib

