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
        // The on-device smoke tests in src/androidTest, run by the Android device workflow.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        applicationId = "com.jtn.frigateviewer"
        minSdk = 29
        targetSdk = 36
        versionCode = 5
        versionName = "0.2.3"
    }

    // The device tests in src/androidTest run against the debug build unless
    // -Pfrigate.testBuildType=minified points them at the minified one below,
    // as the Android device workflow does too.
    testBuildType = providers.gradleProperty("frigate.testBuildType").getOrElse("debug")

    // Release signing: a dedicated key when its four FRIGATE_RELEASE_* values
    // are set, as Gradle properties (~/.gradle/gradle.properties) or environment
    // variables; otherwise this machine's debug key, as before. See the README.
    val releaseSigning = listOf(
        "FRIGATE_RELEASE_KEYSTORE",
        "FRIGATE_RELEASE_KEYSTORE_PASSWORD",
        "FRIGATE_RELEASE_KEY_ALIAS",
        "FRIGATE_RELEASE_KEY_PASSWORD",
    ).associateWith { providers.gradleProperty(it).orElse(providers.environmentVariable(it)).orNull }
    val missingSigning = releaseSigning.filterValues { it.isNullOrEmpty() }.keys
    check(missingSigning.isEmpty() || missingSigning.size == releaseSigning.size) {
        "Release signing needs all of ${releaseSigning.keys}; missing $missingSigning"
    }
    if (missingSigning.isEmpty()) {
        signingConfigs.create("release") {
            storeFile = file(releaseSigning.getValue("FRIGATE_RELEASE_KEYSTORE")!!)
            storePassword = releaseSigning.getValue("FRIGATE_RELEASE_KEYSTORE_PASSWORD")
            keyAlias = releaseSigning.getValue("FRIGATE_RELEASE_KEY_ALIAS")
            keyPassword = releaseSigning.getValue("FRIGATE_RELEASE_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Sideloaded personal app: without a release key, sign with the
            // debug key so `assembleRelease` still produces an installable APK.
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            // WireGuard's native library is about 3.4 MB per ABI. Only 64-bit
            // ones ship: arm64 phones, and x86_64 for emulators and ChromeOS.
            ndk { abiFilters += setOf("arm64-v8a", "x86_64") }
        }
        debug {
            applicationIdSuffix = ".debug"
        }
        // The release build as R8 shrinks it, but always signed with the debug key
        // and installed beside the other two, so the device tests can run on what
        // ships: `./gradlew -Pfrigate.testBuildType=minified :app:connectedMinifiedAndroidTest`.
        create("minified") {
            initWith(getByName("release"))
            applicationIdSuffix = ".minified"
            signingConfig = signingConfigs.getByName("debug")
            // What the device tests call, which the app alone may not need; it is
            // otherwise shrunk as for release (scripts/device-test-keep-rules.sh).
            proguardFile("proguard-device-tests.pro")
            testProguardFile("proguard-test-apk.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        // Version checks would fail the build each time a library ships a
        // release; upgrades are a deliberate change, not a lint finding.
        disable += setOf("OldTargetApi", "GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion")
        warningsAsErrors = true
        // Text the user reads lives in string resources (res/values/strings*.xml), never in layouts or code.
        error += setOf("HardcodedText", "SetTextI18n")
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

// JDK 21 compiles Kotlin and Java alike, and sets their bytecode level.
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
    implementation(libs.androidx.work.runtime)

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
    testImplementation(libs.androidx.work.testing)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    debugImplementation(libs.compose.ui.test.manifest)

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
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

// Unit test coverage. koverVerifyDebug, which scripts/check.sh and CI run, fails
// when line coverage drops below this floor; it was 93% when the floor was set.
kover {
    reports {
        verify {
            rule("Line coverage") {
                minBound(90)
            }
        }
    }
}

// A failing test prints its whole exception, cause and stack included, in the
// build log, rather than only the assertion's class and line.
tasks.withType<Test>().configureEach {
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
    // Test classes run in parallel JVMs, each loading its own Robolectric Android
    // runtime: half the cores (two on CI's four-core runners) keeps them busy
    // without running short of memory.
    maxParallelForks = (Runtime.getRuntime().availableProcessors() / 2).coerceAtLeast(1)
}
