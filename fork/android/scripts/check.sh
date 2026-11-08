#!/usr/bin/env bash
# Runs everything CI runs: formatting, static analysis, unit tests with their
# coverage and its floor, lint, and the debug and minified release builds.
#   --fix    formats before checking
#   --quick  only detekt and the unit tests, for a fast loop while working
set -euo pipefail
cd "$(dirname "$0")/.."

fix=false
quick=false
for arg in "$@"; do
    case "$arg" in
        --fix) fix=true ;;
        --quick) quick=true ;;
        *)
            echo "usage: $0 [--fix] [--quick]" >&2
            exit 2
            ;;
    esac
done

# Gradle needs JDK 21; on macOS pick it when JAVA_HOME is unset.
if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
    JAVA_HOME="$(/usr/libexec/java_home -v 21)"
    export JAVA_HOME
fi

if $quick; then
    tasks=(:app:detekt :app:testDebugUnitTest)
else
    tasks=(spotlessCheck :app:detekt :app:testDebugUnitTest :app:koverXmlReportDebug :app:koverVerifyDebug
        :app:lintDebug :app:assembleDebug :app:assembleRelease)
fi
if $fix; then
    tasks=(spotlessApply "${tasks[@]}")
fi
./gradlew "${tasks[@]}"
$quick && exit 0

# The report's last LINE counter is the whole app's; the HTML report has the detail
# (./gradlew :app:koverHtmlReportDebug). koverVerifyDebug above holds it to the floor
# set in app/build.gradle.kts.
awk -F'"' '/<counter type="LINE"/ { missed = $4; covered = $6 }
    END { if (missed + covered) printf "Line coverage: %.1f%% of %d lines\n", 100 * covered / (missed + covered), missed + covered }' \
    app/build/reports/kover/reportDebug.xml
