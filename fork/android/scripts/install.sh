#!/usr/bin/env bash
# Builds and installs the app on a phone over wireless debugging.
#
#   scripts/install.sh <host:port> [--debug] [--no-build]
#
# <host:port> is the address under Settings > Developer options > Wireless
# debugging on the phone; the port changes each time it is turned on. The
# release build is installed unless --debug is given.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -lt 1 || "$1" == -* ]]; then
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
fi
target="$1"
shift
variant=release
build=1
for arg in "$@"; do
    case "$arg" in
        --debug) variant=debug ;;
        --no-build) build=0 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
    JAVA_HOME="$(/usr/libexec/java_home -v 21)"
    export JAVA_HOME
fi

if [[ $build == 1 ]]; then
    task=":app:assemble$(tr '[:lower:]' '[:upper:]' <<< "${variant:0:1}")${variant:1}"
    ./gradlew -q "$task"
fi

if ! adb connect "$target" | grep -q "connected to"; then
    echo "Could not reach $target. Check that the phone is on the same network and that the" >&2
    echo "port matches the one under Wireless debugging now; it changes each time it is turned on." >&2
    exit 1
fi

apk="app/build/outputs/apk/$variant/app-$variant.apk"
package="com.jtn.frigateviewer"
[[ $variant == debug ]] && package="$package.debug"

# --user 0: with a Secure Folder or work profile on the phone, a plain install
# fails with "Shell does not have permission to access user ...".
adb -s "$target" install --user 0 -r "$apk"
adb -s "$target" shell dumpsys package "$package" | grep -m1 versionName | sed 's/^ */Installed /'
