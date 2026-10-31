package com.jtn.frigateviewer.ui

import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The live feed adds new items and shows what each camera sees without a refresh. */
@RunWith(RobolectricTestRunner::class)
class LiveFeedTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val config = """{"cameras": {"driveway": {"friendly_name": "Driveway"}}}"""

    private val item = """{"id": "r9", "camera": "driveway", "start_time": 1700000000.0, "end_time": null,
        "severity": "alert", "thumb_path": "/t.webp", "data": {"objects": ["person"], "zones": [], "audio": []}}"""

    /** Plays Frigate's side: answers onConnect with the cameras' state, then reports a new alert. */
    private val frigate = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            if ("onConnect" !in text) return
            webSocket.send(message("camera_activity", """{"driveway": {"motion": true, "objects": [{"label": "person"}]}}"""))
            webSocket.send(message("reviews", """{"type": "new", "before": $item, "after": $item}"""))
        }
    }

    private fun message(topic: String, payload: String) = """{"topic": "$topic", "payload": ${JsonPrimitive(payload)}}"""

    @Test
    fun aNewAlertAndActivityArriveWithoutRefreshing() {
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            when (request.url.encodedPath) {
                "/api/config" -> json(config)
                "/ws" -> MockResponse.Builder().webSocketUpgrade(frigate).build()
                else -> null
            }
        }
        val reviewFetches = serverRule.server.requestCount

        compose.awaitMain { vm.reviewById("r9") != null }

        compose.runOnIdle {
            assertTrue(vm.feed.connected)
            assertEquals(1, vm.unreviewedAlerts)
            assertEquals(listOf("person"), vm.feed.activity["driveway"]?.objects)
        }
        compose.onNode(hasContentDescription("Driveway, Person now", substring = true)).assertExists()
        assertTrue("Only the feed was opened", serverRule.server.requestCount <= reviewFetches + 1)
    }
}
