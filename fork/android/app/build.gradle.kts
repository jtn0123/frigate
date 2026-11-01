plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.detekt)
    alias(libs.plugins.kover)
    alias(libs.plugins.roborazzi)
}

android {
    namespace = "com.jtn.frigateviewer"
    // Recent okhttp and androidx artifacts require compileSdk 37; the runtime
    // contract is targetSdk.
    compileSdk = 37

    defaultConfig {
        applicationId = "com.jtn.frigateviewer"
        minSdk = 29
        targetSdk = 36
        versionCode = 4
        versionName = "0.2.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Sideloaded personal app: sign release with the debug key so
            // `assembleRelease` produces an installable APK.
            signingConfig = signingConfigs.getByName("debug")
            // WireGuard's native library is about 3.4 MB per ABI. Only 64-bit
            // ones ship: arm64 phones, and x86_64 for emulators and ChromeOS.
            ndk { abiFilters += setOf("arm64-v8a", "x86_64") }
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    lint {
        // Version checks would fail the build each time a library ships a
        // release; upgrades are a deliberate change, not a lint finding.
        disable += setOf("OldTargetApi", "GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion")
        warningsAsErrors = true
    }

    // Compose UI tests run on the JVM under Robolectric, which needs the resources.
    testOptions {
        unitTests.isIncludeAndroidResources = true
        // Robolectric's Android 16 shadows reach into FileDescriptor internals.
        unitTests.all { it.jvmArgs("--add-opens=java.base/java.io=ALL-UNNAMED", "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED") }
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.datastore.preferences)

    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.ui)
    implementation(libs.media3.datasource.okhttp)

    implementation(libs.okhttp)
    implementation(libs.wireguard.tunnel)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    debugImplementation(libs.compose.ui.test.manifest)
}

// Screenshot tests: the golden images are committed here, and every unit test run
// compares against them (roborazzi.test.verify in gradle.properties). Re-record
// with `./gradlew :app:recordRoborazziDebug` after an intended visual change.
roborazzi {
    outputDir.set(file("src/test/screenshots"))
}

// Kotlin static analysis. Findings that predate it are listed in detekt-baseline.xml;
// regenerate that with `./gradlew :app:detektBaseline` only when accepting new ones.
detekt {
    buildUponDefaultConfig = true
    config.setFrom(rootProject.file("config/detekt.yml"))
    baseline = file("detekt-baseline.xml")
}
