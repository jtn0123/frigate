package com.jtn.frigateviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NightsStay
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import coil3.ImageLoader
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import com.jtn.frigateviewer.data.ReviewData
import com.jtn.frigateviewer.data.ReviewItem
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

    /** A recording that failed, over a bright picture so the scrim's contrast shows. */
    @Test
    fun recordingError() = capture {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color(0xFFD8D2C4))) {
            VodError(UiText.Plain("The server could not send this recording."), onRetry = {}, Modifier.fillMaxSize())
        }
    }

    @Test
    fun settings() {
        val vm = viewModel()
        val session = Session(ServerSettings(baseUrl = "http://nvr.lan:5000/", username = "admin"))
        capture { Chrome { SettingsScreen(vm, session) } }
    }

    /**
     * Text at twice its size: a camera's figures stack rather than cut off, and review rows grow,
     * the reviewed one in grey rather than faded.
     */
    @Test
    fun largeText() {
        val session = Session(ServerSettings(baseUrl = "http://nvr.lan:5000/"))
        val imageLoader = ImageLoader(ApplicationProvider.getApplicationContext())
        val item = ReviewItem(
            id = "1",
            camera = "driveway",
            startTime = 1_700_000_000.0,
            endTime = 1_700_000_042.0,
            severity = "alert",
            thumbPath = "/media/frigate/clips/review/thumb-driveway-1.webp",
            data = ReviewData(objects = listOf("person"), zones = listOf("front_yard")),
        )
        capture {
            val density = Density(LocalDensity.current.density, fontScale = 2f)
            // Twelve minutes after the item, so its time reads the same in any time zone.
            CompositionLocalProvider(LocalDensity provides density, LocalNow provides 1_700_000_720_000L) {
                Chrome {
                    Column {
                        StatRow(Modifier.padding(16.dp)) {
                            Stat("Alerts", "12", Palette.Alert) {}
                            Stat("Detections", "140", Palette.Detection) {}
                            Stat("Last activity", "12m", Palette.TextPrimary)
                        }
                        ReviewRow(item, "Driveway", session, imageLoader, onClick = {})
                        ReviewRow(item.copy(id = "2", reviewed = true), "Driveway", session, imageLoader, onClick = {})
                    }
                }
            }
        }
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
