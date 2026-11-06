package com.jtn.frigateviewer.data

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test

/** Fetching the clips a recording playlist strings together. */
class RecordingSpanTest {
    @get:Rule val serverRule = MockWebServerRule()
    private val server: MockWebServer get() = serverRule.server

    private fun api() = FrigateApi(buildHttpClient(null, pin = null), server.url("/").toString())

    private fun reply(body: String, code: Int = 200) = server.enqueue(MockResponse.Builder().code(code).body(body).build())

    @Test
    fun readsTheDefaultPlaylistsRealizedTimeline() = runTest {
        reply(
            """{"spans": [], "codecs_compatible": true, "streams": {}, "timelines": {
                "auto": [{"start_time": 100.0, "end_time": 110.0, "duration": 10500}, {"start_time": 200.0, "end_time": 210.0, "duration": 0}],
                "main": [], "sub": []}}""",
        )

        val spans = api().recordingSpans("driveway", 100, 300)

        assertEquals(listOf(RecordingSpan(100.0, 110.0, 10_500), RecordingSpan(200.0, 210.0, 0)), spans)
        val request = server.takeRequest()
        assertEquals("/api/driveway/recordings/coverage", request.url.encodedPath)
        assertEquals("100", request.url.queryParameter("after"))
        assertEquals("300", request.url.queryParameter("before"))
        assertEquals("true", request.url.queryParameter("timelines"))
        assertEquals("One call when the server has the timeline", 1, server.requestCount)
    }

    @Test
    fun aServerWithoutTheTimelineGivesItsRecordings() = runTest {
        reply("""{"spans": [], "codecs_compatible": true}""")
        reply("""[{"id": "a", "start_time": 95.0, "end_time": 105.0, "duration": 9.75, "motion": 3}]""")

        val spans = api().recordingSpans("driveway", 100, 300)

        assertEquals(listOf(RecordingSpan(95.0, 105.0, 9_750)), spans)
        server.takeRequest()
        val request = server.takeRequest()
        assertEquals("/api/driveway/recordings", request.url.encodedPath)
        assertEquals("100", request.url.queryParameter("after"))
        assertEquals("300", request.url.queryParameter("before"))
    }

    @Test
    fun aServerWithoutCoverageAtAllGivesItsRecordings() = runTest {
        reply("""{"detail": "Not Found"}""", code = 404)
        reply("""[{"start_time": 100.0, "end_time": 110.0, "duration": 10.0}]""")

        assertEquals(listOf(RecordingSpan(100.0, 110.0, 10_000)), api().recordingSpans("driveway", 100, 300))
    }

    @Test
    fun otherFailuresAreNotHidden() = runTest {
        reply("{}", code = 500)

        try {
            api().recordingSpans("driveway", 100, 300)
            fail("A server error is the caller's to handle")
        } catch (e: HttpException) {
            assertEquals(500, e.code)
        }
        assertEquals("No second guess after a server error", 1, server.requestCount)
    }
}
