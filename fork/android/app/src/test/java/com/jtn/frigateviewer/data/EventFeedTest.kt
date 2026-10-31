package com.jtn.frigateviewer.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EventFeedTest {
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
}
