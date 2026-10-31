package com.jtn.frigateviewer.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import com.jtn.frigateviewer.data.ServerSettings
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Fullscreen on a screen wider than the camera letterboxes the video instead of stretching it. */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w900dp-h360dp-land")
class VideoFitTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun landscapeKeepsTheCamerasShape() {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/config" -> json(
                    """{"cameras": {"driveway": {"friendly_name": "Driveway", "detect": {"width": 1280, "height": 720}}}}""",
                )
                "/api/review" -> json("[]")
                else -> json("{}")
            }
        }
        val store = testSettingsStore(File(temp.root, "server.preferences_pb"), scope)
        runBlocking { store.save(ServerSettings(baseUrl = serverRule.server.url("/").toString())) }
        val vm = AppViewModel(SavedStateHandle(), store)
        compose.setContent { App(vm) }
        compose.awaitMain { vm.cameras is Remote.Ready }
        compose.runOnIdle { vm.nav.openCamera("driveway") }
        compose.waitForIdle()

        // A 16:9 picture on a 900x360 screen is 640 wide, centered: 130 dp of black each side.
        val root = compose.onRoot().getUnclippedBoundsInRoot()
        val button = compose.onNodeWithContentDescription("Exit fullscreen").getUnclippedBoundsInRoot()
        assertTrue("video reaches ${button.right} of ${root.right}", button.right < root.right - 100.dp)
    }
}
