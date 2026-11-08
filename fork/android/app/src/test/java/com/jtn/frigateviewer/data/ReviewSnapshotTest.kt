package com.jtn.frigateviewer.data

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The picture shared for a review item: its first object's snapshot, or the recorded frame from when it began. */
class ReviewSnapshotTest {
    @get:Rule val serverRule = MockWebServerRule()

    private val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 1, 2, 3)

    private val api by lazy { FrigateApi(buildHttpClient(null, null), serverRule.server.url("/").toString()) }

    private fun item(detections: List<String> = emptyList(), startTime: Double = START) = ReviewItem(
        id = "r1",
        camera = "driveway",
        startTime = startTime,
        severity = "alert",
        thumbPath = "/media/frigate/clips/review/thumb-driveway-r1.webp",
        data = ReviewData(objects = listOf("person"), detections = detections),
    )

    private fun answer(code: Int = 200) =
        serverRule.server.enqueue(MockResponse.Builder().code(code).body(Buffer().write(jpeg)).build())

    @Test
    fun anItemWithObjectsSharesTheFirstOnesSnapshot() {
        answer()

        val bytes = runBlocking { api.reviewSnapshot(item(detections = listOf("ev1", "ev2"))) }

        assertArrayEquals(jpeg, bytes)
        assertEquals("/api/events/ev1/snapshot.jpg", serverRule.server.takeRequest().url.encodedPath)
    }

    @Test
    fun anItemWithoutObjectsSharesTheFrameASecondIn() {
        answer()

        val bytes = runBlocking { api.reviewSnapshot(item(startTime = START)) }

        assertArrayEquals(jpeg, bytes)
        val segments = serverRule.server.takeRequest().url.pathSegments
        assertEquals(listOf("api", "driveway", "recordings"), segments.take(3))
        assertEquals("snapshot.jpg", segments.last())
        // A second after it began, so the frame is from inside the recording.
        assertEquals(START + 1, segments[3].toDouble(), 0.0)
    }

    @Test
    fun aRefusedSnapshotFailsWithTheStatus() {
        answer(404)

        val failure = runCatching { runBlocking { api.reviewSnapshot(item(detections = listOf("ev1"))) } }.exceptionOrNull()

        assertTrue("Expected an HTTP failure, got $failure", failure is HttpException)
        assertEquals(404, (failure as HttpException).code)
    }

    @Test
    fun anExpiredSessionFailsAsSignedOut() {
        answer(401)

        val failure = runCatching { runBlocking { api.reviewSnapshot(item()) } }.exceptionOrNull()

        assertTrue("Expected the session to be refused, got $failure", failure is AuthException)
    }

    private companion object {
        const val START = 1_700_000_000.25
    }
}
