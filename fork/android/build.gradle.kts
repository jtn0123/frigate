// Root build file. Plugins are declared (not applied) here so the version
// catalog resolves them once for every module.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
    alias(libs.plugins.spotless)
    alias(libs.plugins.detekt) apply false
    alias(libs.plugins.roborazzi) apply false
}

// Formatting: ktlint in the IntelliJ style, keeping trailing commas and lines up
// to 140 characters. `./gradlew spotlessApply` fixes what it can.
val ktlintRules = mapOf(
    "ktlint_code_style" to "intellij_idea",
    "max_line_length" to "140",
    "ij_kotlin_allow_trailing_comma" to "true",
    "ij_kotlin_allow_trailing_comma_on_call_site" to "true",
    // Imports in plain alphabetical order.
    "ij_kotlin_imports_layout" to "*",
    // Composables are named like types.
    "ktlint_function_naming_ignore_when_annotated_with" to "Composable",
    // Leave signatures and when branches as written: wrapping a long signature
    // or expression body is a readability call, not a formatting error.
    "ktlint_standard_function-signature" to "disabled",
    "ktlint_standard_class-signature" to "disabled",
    "ktlint_standard_blank-line-between-when-conditions" to "disabled",
)

spotless {
    kotlin {
        target("app/src/**/*.kt")
        ktlint(libs.versions.ktlint.get()).editorConfigOverride(ktlintRules)
    }
    kotlinGradle {
        target("*.gradle.kts", "app/*.gradle.kts")
        ktlint(libs.versions.ktlint.get()).editorConfigOverride(ktlintRules)
    }
}
