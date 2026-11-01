package com.jtn.frigateviewer.ui

import android.os.Looper
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.SavedStateHandle
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ReviewItem
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
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** Stepping through items from an open one, and the way back to the camera. */
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

    private fun show(): AppViewModel {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/config" -> MockResponse.Builder().body(config).build()
                "/api/review" -> MockResponse.Builder().body(reviews).build()
                else -> MockResponse.Builder().body("{}").build()
            }
        }
        val store = testSettingsStore(File(temp.root, "server.preferences_pb"), storeScope)
        runBlocking { store.save(ServerSettings(baseUrl = serverRule.server.url("/").toString())) }
        val vm = AppViewModel(SavedStateHandle(), store)
        compose.setContent { App(vm) }
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
    }
}
