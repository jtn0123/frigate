package com.jtn.frigateviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NightsStay
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.lifecycle.SavedStateHandle
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Session
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Golden images of the main screens on a phone, compared on every unit test run.
 * Re-record them with `./gradlew :app:recordRoborazziDebug` after an intended change.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class ScreenshotTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val temp = TemporaryFolder()

    private val storeScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        storeScope.cancel()
    }

    private fun viewModel() = AppViewModel(SavedStateHandle(), testSettingsStore(File(temp.root, "server.preferences_pb"), storeScope))

    /** Shows [content] themed as in the app, with the clock held so animations stay on their first frame. */
    private fun capture(content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent { FrigateTheme { Surface(Modifier.fillMaxSize()) { content() } } }
        compose.waitForIdle()
        compose.onRoot().captureRoboImage(roborazziOptions = options)
    }

    @Test
    fun signIn() {
        val vm = viewModel()
        capture { LoginScreen(vm) }
    }

    @Test
    fun reviewListSkeleton() = capture { Chrome { ReviewListSkeleton() } }

    @Test
    fun cameraGridSkeleton() = capture { Chrome { CameraGridSkeleton(columns = 2) } }

    @Test
    fun emptyState() = capture {
        Chrome { EmptyState(Icons.Outlined.NightsStay, "All quiet", detail = "Nothing happened in the last 24 hours.") }
    }

    @Test
    fun settings() {
        val vm = viewModel()
        val session = Session(ServerSettings(baseUrl = "http://nvr.lan:5000/", username = "admin"))
        capture { Chrome { SettingsScreen(vm, session) } }
    }

    /** The app's backdrop behind the tabs, as `App` draws it. */
    @Composable
    private fun Chrome(content: @Composable () -> Unit) {
        Box(Modifier.fillMaxSize().background(Palette.Chrome)) { content() }
    }

    private companion object {
        /**
         * Text is drawn by the host's native graphics, which can differ by a few
         * antialiased pixels between macOS and Linux CI; a real change moves far more.
         */
        val options = RoborazziOptions(compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.01f))
    }
}
