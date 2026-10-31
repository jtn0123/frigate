package com.jtn.frigateviewer.data

import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Waiting for a clip the server is cutting, with its export job's status where the server has one. */
class ExportTest {
    @get:Rule val serverRule = MockWebServerRule()

    private val done = """[{"id": "front_1", "in_progress": false, "video_path": "/media/frigate/exports/front_1.mp4"}]"""
    private val running = """[{"id": "front_1", "in_progress": true, "video_path": ""}]"""

    /** Serves `/api/exports` and `/api/jobs/export/front_1` from [exports] and [job], given each poll's number. */
    private fun api(exports: (Int) -> String, job: (Int) -> MockResponse): FrigateApi {
        val polls = AtomicInteger()
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/exports" -> MockResponse.Builder().body(exports(polls.incrementAndGet())).build()
                "/api/jobs/export/front_1" -> job(polls.get())
                else -> MockResponse.Builder().code(404).build()
            }
        }
        return FrigateApi(buildHttpClient(null, null), serverRule.server.url("/").toString())
    }

    private fun job(status: String, error: String? = null) =
        MockResponse.Builder().body("""{"id": "front_1", "status": "$status", "error_message": ${error?.let { "\"$it\"" }}}""").build()

    private val notFound = MockResponse.Builder().code(404).body("""{"success": false, "message": "Job not found"}""").build()

    private fun failure(api: FrigateApi) = runCatching { runBlocking { api.awaitExport("front_1", intervalMs = 10) } }.exceptionOrNull()

    @Test
    fun aFailedJobEndsTheWaitWithTheServersReason() {
        val api = api(exports = { "[]" }, job = { if (it < 3) job("running") else job("failed", "No recordings found") })
        val error = failure(api)
        assertTrue(error is IOException)
        assertEquals("The server could not make the clip (No recordings found)", error?.message)
    }

    @Test
    fun aJobThatVanishesWithoutAnExportEndsTheWait() {
        val api = api(exports = { running }, job = { if (it < 3) job("running") else notFound })
        assertEquals("The server stopped making the clip", failure(api)?.message)
    }

    @Test
    fun aFinishedJobsExportIsDownloadedEvenAfterTheJobIsDropped() {
        val api = api(exports = { if (it < 4) running else done }, job = { if (it < 3) job("running") else notFound })
        assertEquals("/media/frigate/exports/front_1.mp4", runBlocking { api.awaitExport("front_1", intervalMs = 10) }.videoPath)
    }

    @Test
    fun aServerWithoutJobStatusIsWaitedOnAsBefore() {
        val api = api(exports = { if (it < 3) running else done }, job = { notFound })
        assertEquals("front_1", runBlocking { api.awaitExport("front_1", intervalMs = 10) }.id)
    }
}
