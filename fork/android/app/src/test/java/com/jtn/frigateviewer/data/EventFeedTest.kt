package com.jtn.frigateviewer.data

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class EventFeedTest {
    @get:Rule val serverRule = MockWebServerRule()

    @Test
    fun aFeedTheAppFallsBehindOnEndsSoTheReconnectCatchesUp() {
        val closed = CountDownLatch(1)
        serverRule.server.enqueue(
            MockResponse.Builder().webSocketUpgrade(
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        // Far more than the feed holds while the app is busy.
                        repeat(MESSAGES) {
                            webSocket.send("""{"topic": "garage/motion", "payload": "${if (it % 2 == 0) "ON" else "OFF"}"}""")
                        }
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, null)
                        closed.countDown()
                    }
                },
            ).build(),
        )
        val client = OkHttpClient()
        var received = 0

        val failure = runCatching {
            runBlocking {
                eventFeed(client, serverRule.server.url("/ws").toString()).flowOn(Dispatchers.IO).collect {
                    // Busy until the feed gives up on it, which it should rather than drop events.
                    if (received++ == 0) assertTrue("The feed was not closed", closed.await(10, TimeUnit.SECONDS))
                }
            }
        }.exceptionOrNull()

        assertTrue("Expected the feed to end with an IOException, got $failure", failure is IOException)
        assertTrue("Not everything was delivered: $received", received < MESSAGES + 1)
        client.dispatcher.executorService.shutdown()
    }

    @Test
    fun aReviewWithNullsWhereListsBelongIsStillRead() {
        val after = """{"id": "r9", "camera": "driveway", "start_time": 1700000000.5, "end_time": null, "severity": "alert",
            "has_been_reviewed": null, "thumb_path": "/r9.webp", "data": {"objects": null, "zones": null, "detections": ["e1"]}}"""
        val message = """{"topic": "reviews", "payload": ${quote("""{"type": "end", "after": $after}""")}}"""

        val event = parseFeedMessage(message) as FeedEvent.Review

        assertEquals("r9", event.item.id)
        assertEquals(emptyList<String>(), event.item.data.objects)
        assertEquals(emptyList<String>(), event.item.data.zones)
        assertEquals(listOf("e1"), event.item.data.detections)
    }

    @Test
    fun aNewReviewSentAsAStringIsRead() {
        val after = """{"id": "r9", "camera": "driveway", "start_time": 1700000000.5, "end_time": null, "severity": "alert",
            "thumb_path": "/media/frigate/clips/review/r9.webp", "data": {"objects": ["person"], "detections": ["e1"], "zones": [], "audio": []}}"""
        val payload = """{"type": "new", "before": $after, "after": $after}"""
        val message = """{"topic": "reviews", "payload": ${quote(payload)}}"""

        val event = parseFeedMessage(message) as FeedEvent.Review

        assertEquals("new", event.type)
        assertEquals("r9", event.item.id)
        assertEquals(listOf("person"), event.item.data.objects)
        assertNull(event.item.endTime)
    }

    @Test
    fun cameraActivityGivesMotionObjectsAndSwitches() {
        val payload = """{"driveway": {"motion": true, "objects": [{"label": "car", "stationary": false}, {"label": "car"}, {"label": "dog", "stationary": true}],
            "config": {"detect": true, "record": false, "enabled": true}}, "garage": {"motion": false, "objects": []}}"""
        val message = """{"topic": "camera_activity", "payload": ${quote(payload)}}"""

        val event = parseFeedMessage(message) as FeedEvent.Activity

        assertEquals(
            CameraActivity(true, listOf("car"), mapOf("detect" to true, "recordings" to false, "enabled" to true)),
            event.cameras["driveway"],
        )
        assertEquals(CameraActivity(), event.cameras["garage"])
    }

    @Test
    fun motionAndSwitchTopicsAreRead() {
        assertEquals(FeedEvent.Motion("garage", true), parseFeedMessage("""{"topic": "garage/motion", "payload": "ON"}"""))
        assertEquals(
            FeedEvent.Switch("garage", "detect", false),
            parseFeedMessage("""{"topic": "garage/detect/state", "payload": "OFF"}"""),
        )
    }

    @Test
    fun otherTopicsAndJunkAreIgnored() {
        assertNull(parseFeedMessage("""{"topic": "stats", "payload": "{}"}"""))
        assertNull(parseFeedMessage("""{"topic": "garage/detect/set", "payload": "OFF"}"""))
        assertNull(parseFeedMessage("""{"topic": "reviews", "payload": "not json"}"""))
        assertNull(parseFeedMessage("nope"))
    }

    private fun quote(text: String) = kotlinx.serialization.json.JsonPrimitive(text).toString()

    private companion object {
        const val MESSAGES = 500
    }
}
