package com.jtn.frigateviewer.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import com.jtn.frigateviewer.data.FrigateApi
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Admins switch cameras and move PTZ cameras over the live feed; nothing here touches a real server. */
@RunWith(RobolectricTestRunner::class)
class CameraControlsTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val config = """{"cameras": {"porch": {"friendly_name": "Porch", "onvif": {"host": "cam.local"}}}}"""

    /** What the app sent over the feed, as topic=payload. */
    private val sent = CopyOnWriteArrayList<String>()

    private val frigate = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = Unit

        override fun onMessage(webSocket: WebSocket, text: String) {
            if ("onConnect" in text) {
                val switches = """{"detect": true, "record": true, "snapshots": false}"""
                val activity = """{"porch": {"motion": false, "objects": [], "config": $switches}}"""
                webSocket.send("""{"topic": "camera_activity", "payload": ${JsonPrimitive(activity)}}""")
                return
            }
            val message = kotlinx.serialization.json.Json.parseToJsonElement(text) as kotlinx.serialization.json.JsonObject
            sent += "${(message["topic"] as JsonPrimitive).content}=${(message["payload"] as JsonPrimitive).content}"
        }
    }

    private fun show(role: String): AppViewModel {
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            when (request.url.encodedPath) {
                "/api/config" -> json(config)
                "/api/profile" -> json("""{"username": "someone", "role": "$role"}""")
                "/api/porch/ptz/info" -> json("""{"name": "porch", "features": ["pt", "zoom"], "presets": ["gate", "street"]}""")
                "/ws" -> MockResponse.Builder().webSocketUpgrade(frigate).build()
                else -> null
            }
        }
        compose.awaitMain { vm.feed.connected && vm.feed.activity["porch"] != null }
        compose.runOnIdle { vm.nav.openCamera("porch") }
        return vm
    }

    /** The switches and the motor are in the camera's settings, off the video. */
    private fun openSettings() {
        compose.onNodeWithContentDescription("Camera settings").performClick()
        compose.awaitText("Porch settings")
    }

    private fun scrollTo(text: String) {
        compose.onNode(hasText(text)).performScrollTo()
    }

    private fun awaitSent(message: String) = compose.awaitMain { message in sent }

    @Test
    fun anAdminTurnsDetectionOffAfterConfirmingAndSnapshotsOnDirectly() {
        val vm = show("admin")
        compose.awaitMain { vm.controls.isAdmin }
        openSettings()
        scrollTo("Object detection")

        compose.onNodeWithText("Object detection").performClick()
        compose.onNodeWithText("Turn off object detection for Porch?").assertExists()
        assertTrue(sent.isEmpty())
        compose.onNodeWithText("Turn off").performClick()
        awaitSent("porch/detect/set=OFF")

        scrollTo("Snapshots")
        compose.onNodeWithText("Snapshots").performClick()
        awaitSent("porch/snapshots/set=ON")
    }

    @Test
    fun holdingAnArrowMovesUntilLetGoAndPresetsAreOneTap() {
        val vm = show("admin")
        compose.awaitMain { vm.controls.isAdmin }
        openSettings()
        compose.awaitMain { compose.onAllNodes(hasContentDescription("Tilt down")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Tilt down").performScrollTo()

        compose.onNodeWithContentDescription("Pan left").performTouchInput {
            down(center)
            advanceEventTime(300)
            up()
        }
        awaitSent("porch/ptz=STOP")
        assertEquals(listOf("porch/ptz=MOVE_LEFT", "porch/ptz=STOP"), sent.toList())

        // Robolectric leaves the presets' scrolling row in the sheet's window unplaced,
        // so the chip is tapped by its action.
        compose.onNodeWithText("gate").performSemanticsAction(SemanticsActions.OnClick)
        awaitSent("porch/ptz=preset_gate")
    }

    @Test
    fun viewersGetNoControls() {
        val vm = show("viewer")
        compose.waitForIdle()
        assertFalse(vm.controls.isAdmin)
        compose.onNodeWithText("Activity · last 24 hours").assertExists()
        // One stream and no switches to offer: nothing to set.
        compose.onNodeWithContentDescription("Camera settings").assertDoesNotExist()
    }

    @Test
    fun onvifCamerasAreMarkedForPtz() {
        val camera = FrigateApi.parseConfig(config).cameras.single()
        assertTrue(camera.onvif)
        assertFalse(FrigateApi.parseConfig("""{"cameras": {"yard": {}}}""").cameras.single().onvif)
    }
}
