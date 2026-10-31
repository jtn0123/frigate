#!/usr/bin/env bash
# Runs everything CI runs: formatting, static analysis, unit tests with their
# coverage, lint, and the debug and minified release builds. Pass --fix to
# format before checking.
set -euo pipefail
cd "$(dirname "$0")/.."

# Gradle needs JDK 21; on macOS pick it when JAVA_HOME is unset.
if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
    JAVA_HOME="$(/usr/libexec/java_home -v 21)"
    export JAVA_HOME
fi

tasks=(spotlessCheck :app:detekt :app:testDebugUnitTest :app:koverXmlReportDebug :app:lintDebug :app:assembleDebug :app:assembleRelease)
if [[ "${1:-}" == "--fix" ]]; then
    tasks=(spotlessApply "${tasks[@]}")
fi
./gradlew "${tasks[@]}"

# The report's last LINE counter is the whole app's; the HTML report has the detail
# (./gradlew :app:koverHtmlReportDebug).
awk -F'"' '/<counter type="LINE"/ { missed = $4; covered = $6 }
    END { if (missed + covered) printf "Line coverage: %.1f%% of %d lines\n", 100 * covered / (missed + covered), missed + covered }' \
    app/build/reports/kover/reportDebug.xml
