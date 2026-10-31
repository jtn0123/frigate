package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.FeedCommands
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.buildHttpClient
import com.jtn.frigateviewer.tunnel.await
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The live feed on its own, against a server that drops it once. */
class LiveFeedStateTest {
    @get:Rule val serverRule = MockWebServerRule()

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val item = """{"id": "r9", "camera": "driveway", "start_time": 1700000000.0, "end_time": null,
        "severity": "alert", "thumb_path": "/t.webp", "data": {"objects": ["person"], "zones": [], "audio": []}}"""

    private fun message(topic: String, payload: String) = """{"topic": "$topic", "payload": ${JsonPrimitive(payload)}}"""

    /** Answers onConnect with the cameras' state and a new alert, then closes the first connection cleanly, as a restart does. */
    private fun frigate(closeAfter: Boolean) = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            if ("onConnect" !in text) return
            webSocket.send(message("camera_activity", """{"driveway": {"motion": true, "objects": [{"label": "person"}]}}"""))
            webSocket.send(message("reviews", """{"type": "new", "before": $item, "after": $item}"""))
            webSocket.send("""{"topic": "driveway/motion", "payload": "OFF"}""")
            if (closeAfter) webSocket.close(GOING_AWAY, "restarting")
        }

        // Finish the app's close at the end of the test, so the server can shut down.
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
        }
    }

    @Test
    fun itFollowsTheFeedAndCatchesUpAfterADrop() {
        val server = serverRule.server
        server.enqueue(MockResponse.Builder().webSocketUpgrade(frigate(closeAfter = true)).build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(frigate(closeAfter = false)).build())
        val api = FrigateApi(buildHttpClient(null, pin = null), server.url("/").toString())
        val reviews = CopyOnWriteArrayList<ReviewItem>()
        val commands = CopyOnWriteArrayList<FeedCommands?>()
        val reconnects = AtomicInteger()
        val feed = LiveFeed({ api }, reviews::add, commands::add, onReconnect = { reconnects.incrementAndGet() })

        scope.launch { feed.follow() }

        await { reviews.isNotEmpty() && feed.activity["driveway"]?.motion == false }
        // Motion ending clears what the camera saw.
        assertTrue(feed.activity.getValue("driveway").objects.isEmpty())
        assertEquals("r9", reviews.first().id)
        assertTrue(commands.first() != null)

        // The server closes the first connection; the second one fetches what was missed.
        await(timeoutMs = 10_000) { reconnects.get() == 1 && feed.connected }
        assertNull("Commands stop while the feed is down", commands[1])
        assertEquals(2, server.requestCount)
    }

    @Test
    fun withoutASessionItStops() {
        val feed = LiveFeed({ null }, onReview = {}, onCommands = {}, onReconnect = {})
        runBlocking { feed.follow() }
        assertFalse(feed.connected)
    }
}

private const val GOING_AWAY = 1001
