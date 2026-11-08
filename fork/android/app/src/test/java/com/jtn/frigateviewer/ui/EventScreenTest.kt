package com.jtn.frigateviewer.ui

import android.os.Looper
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import com.jtn.frigateviewer.data.MediaFiles
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.ServerSettings
import java.io.File
import java.io.OutputStream
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** Stepping through items from an open one, in fullscreen too, and the way back to the camera. */
@RunWith(RobolectricTestRunner::class)
class EventScreenTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val storeScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val config = """
        {"cameras": {"driveway": {"enabled": true, "friendly_name": "Driveway", "detect": {"width": 1280, "height": 720}}}}
    """.trimIndent()

    /** Three alerts on one camera, newest first as Frigate lists them. */
    private val reviews = listOf("new" to 300, "middle" to 200, "old" to 100).joinToString(prefix = "[", postfix = "]") { (id, at) ->
        """{"id": "$id", "camera": "driveway", "start_time": 1700000$at.0, "end_time": 1700000${at + 10}.0,
            "has_been_reviewed": false, "severity": "alert", "thumb_path": "/t/$id.webp",
            "data": {"objects": ["person"], "zones": [], "audio": []}}"""
    }

    @After
    fun tearDown() {
        storeScope.cancel()
    }

    /** Saving and sharing are offered only with somewhere to put the files. */
    private val media = object : MediaFiles {
        override suspend fun saveVideo(name: String, write: suspend (OutputStream) -> Unit) = "content://media/video/1"

        override suspend fun shareable(name: String, bytes: ByteArray) = "content://files/shared/$name"
    }

    /** The app in a window of [window], or as it comes; [markOnOpen] as the setting, which leaves Mark reviewed to offer when off. */
    private fun show(window: DpSize? = null, markOnOpen: Boolean = true): AppViewModel {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/config" -> MockResponse.Builder().body(config).build()
                "/api/review" -> MockResponse.Builder().body(reviews).build()
                else -> MockResponse.Builder().body("{}").build()
            }
        }
        val store = testSettingsStore(File(temp.root, "server.preferences_pb"), storeScope)
        runBlocking { store.save(ServerSettings(baseUrl = serverRule.server.url("/").toString(), markReviewedOnOpen = markOnOpen)) }
        val vm = AppViewModel(SavedStateHandle(), store, media = media)
        compose.setContent { if (window != null) Window(window) { App(vm) } else App(vm) }
        awaitMain { vm.reviews is Remote.Ready && vm.cameras is Remote.Ready }
        return vm
    }

    private fun AppViewModel.item(id: String): ReviewItem = reviewById(id)!!

    private fun AppViewModel.openEventId() = (nav.overlays.last() as Overlay.Event).reviewId

    @Test
    fun olderAndNewerStepThroughTheListAndStopAtItsEnds() {
        val vm = show()
        compose.runOnIdle { vm.openEvent(vm.item("middle")) }

        compose.onNodeWithText("Older").performClick()
        compose.runOnIdle { assertEquals("old", vm.openEventId()) }
        compose.onNodeWithText("Older").assertIsNotEnabled()

        compose.onNodeWithText("Newer").performClick()
        compose.onNodeWithText("Newer").performClick()
        compose.runOnIdle { assertEquals("new", vm.openEventId()) }
        compose.onNodeWithText("Newer").assertIsNotEnabled()
        compose.onNodeWithText("Older").assertIsEnabled()

        compose.runOnIdle { assertEquals("Stepping replaces the screen", 1, vm.nav.overlays.size) }
    }

    @Test
    fun anItemOpenedFromReviewOffersTheCameraLive() {
        val vm = show()
        compose.runOnIdle { vm.openEvent(vm.item("middle")) }

        compose.onNodeWithText("Watch Driveway live", substring = true).performClick()

        compose.runOnIdle { assertEquals(Overlay.CameraDetail("driveway"), vm.nav.overlays.last()) }
    }

    @Test
    fun anItemOpenedFromItsCameraDoesNotOfferItAgain() {
        val vm = show()
        compose.runOnIdle {
            vm.nav.openCamera("driveway")
            vm.openEvent(vm.item("middle"))
        }

        compose.onNodeWithText("Older").assertExists()
        compose.onNodeWithText("Watch Driveway live", substring = true).assertDoesNotExist()
    }

    @Test
    fun fullscreenKeepsTheStepsAndActionsWithinReach() {
        val vm = show(PHONE_SIDEWAYS, markOnOpen = false)
        compose.runOnIdle { vm.openEvent(vm.item("middle")) }
        compose.onNodeWithContentDescription("Exit fullscreen").assertExists()

        listOf("Older", "Newer", "Share snapshot", "Save clip", "Mark reviewed").forEach { action ->
            compose.onNodeWithContentDescription(action)
                .assertIsEnabled()
                .assertHasClickAction()
                .assertTouchTargetIsAtLeast(48.dp)
        }

        compose.onNodeWithContentDescription("Mark reviewed").performClick()
        compose.runOnIdle { assertTrue(vm.item("middle").reviewed) }
        compose.onNodeWithContentDescription("Mark reviewed").assertDoesNotExist()

        compose.onNodeWithContentDescription("Older").performClick()
        compose.runOnIdle { assertEquals("old", vm.openEventId()) }
        compose.onNodeWithContentDescription("Older").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Exit fullscreen").assertExists()
    }

    @Test
    fun steppingInFullscreenStaysFullscreen() {
        // A tablet held sideways has room for the details, so fullscreen is only by asking.
        val vm = show(TABLET_SIDEWAYS)
        compose.runOnIdle { vm.openEvent(vm.item("middle")) }
        compose.onNodeWithContentDescription("Fullscreen").performClick()

        compose.onNodeWithContentDescription("Newer").performClick()

        compose.runOnIdle { assertEquals("new", vm.openEventId()) }
        compose.onNodeWithContentDescription("Exit fullscreen").assertExists()
    }

    /** Asserts the node takes touches across at least [size] each way, however small it draws. */
    private fun SemanticsNodeInteraction.assertTouchTargetIsAtLeast(size: Dp): SemanticsNodeInteraction {
        val bounds = fetchSemanticsNode().touchBoundsInRoot
        val least = with(compose.density) { size.toPx() }
        assertTrue("Touch target $bounds", bounds.width >= least && bounds.height >= least)
        return this
    }

    /** Waits for [condition], running the main looper, where the view model's work resumes. */
    private fun awaitMain(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "Timed out" }
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        compose.waitForIdle()
    }

    private companion object {
        const val TIMEOUT_MS = 5_000L
        val PHONE_SIDEWAYS = DpSize(860.dp, 400.dp)
        val TABLET_SIDEWAYS = DpSize(1280.dp, 800.dp)
    }
}
