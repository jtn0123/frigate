package com.jtn.frigateviewer.data

import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Waiting for a clip the server is cutting: its export job is polled where the
 * server has one, and the export itself is read once at the end. Runs on
 * virtual time, so the 2 second polls take no real time.
 */
class ExportTest {
    @get:Rule val serverRule = MockWebServerRule()

    private val done = """{"id": "front_1", "in_progress": false, "video_path": "/media/frigate/exports/front_1.mp4"}"""
    private val running = """{"id": "front_1", "in_progress": true, "video_path": ""}"""

    /** How often each path was asked for. */
    private val asked = ConcurrentHashMap<String, AtomicInteger>()

    private fun asked(path: String) = asked[path]?.get() ?: 0

    /**
     * Serves `/api/jobs/export/front_1` from [job] given its poll's number,
     * `/api/exports/front_1` from [export], and the whole `/api/exports`
     * list from [list] given its read's number.
     */
    private fun api(job: (Int) -> MockResponse, export: () -> MockResponse = { notFound }, list: (Int) -> String = { "[]" }): FrigateApi {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                val count = asked.getOrPut(path) { AtomicInteger() }.incrementAndGet()
                return when (path) {
                    "/api/jobs/export/front_1" -> job(count)
                    "/api/exports/front_1" -> export()
                    "/api/exports" -> MockResponse.Builder().body(list(count)).build()
                    else -> notFound
                }
            }
        }
        return FrigateApi(buildHttpClient(null, null), serverRule.server.url("/").toString())
    }

    private fun job(status: String, error: String? = null) =
        MockResponse.Builder().body("""{"id": "front_1", "status": "$status", "error_message": ${error?.let { "\"$it\"" }}}""").build()

    private fun body(json: String) = MockResponse.Builder().body(json).build()

    private val notFound = MockResponse.Builder().code(404).body("""{"success": false, "message": "Job not found"}""").build()

    private suspend fun TestScope.await(api: FrigateApi, timeoutMs: Long = EXPORT_TIMEOUT_MS) =
        api.awaitExport("front_1", timeoutMs = timeoutMs, clock = { testScheduler.currentTime })

    private suspend fun TestScope.failure(api: FrigateApi, timeoutMs: Long = EXPORT_TIMEOUT_MS) =
        runCatching { await(api, timeoutMs) }.exceptionOrNull()

    @Test
    fun theJobIsPolledAndTheExportReadOnceWhenItSucceeds() = runTest {
        val api = api(job = { if (it < 4) job("running") else job("success") }, export = { body(done) })
        assertEquals("/media/frigate/exports/front_1.mp4", await(api).videoPath)
        assertEquals(4, asked("/api/jobs/export/front_1"))
        assertEquals(1, asked("/api/exports/front_1"))
        assertEquals("the whole list of exports is never downloaded", 0, asked("/api/exports"))
        assertEquals("three polls apart", 3 * EXPORT_POLL_MS, testScheduler.currentTime)
    }

    @Test
    fun aFailedJobEndsTheWaitWithTheServersReason() = runTest {
        val api = api(job = { if (it < 3) job("running") else job("failed", "No recordings found") })
        val error = failure(api)
        assertTrue(error is IOException)
        assertEquals("The server could not make the clip (No recordings found)", error?.message)
        assertEquals(0, asked("/api/exports"))
    }

    @Test
    fun aJobThatVanishesWithoutAnExportEndsTheWait() = runTest {
        val api = api(job = { if (it < 3) job("running") else notFound }, export = { body(running) })
        assertEquals("The server stopped making the clip", failure(api)?.message)
        assertEquals(1, asked("/api/exports/front_1"))
    }

    @Test
    fun aSucceededJobWithoutItsExportEndsTheWait() = runTest {
        val api = api(job = { job("success") })
        assertEquals("The server stopped making the clip", failure(api)?.message)
    }

    @Test
    fun aFinishedJobsExportIsDownloadedEvenAfterTheJobIsDropped() = runTest {
        val api = api(job = { if (it < 3) job("running") else notFound }, export = { body(done) })
        assertEquals("/media/frigate/exports/front_1.mp4", await(api).videoPath)
        assertEquals(0, asked("/api/exports"))
    }

    @Test
    fun aServerWithoutJobStatusIsWaitedOnAsBefore() = runTest {
        val api = api(job = { notFound }, list = { if (it < 3) "[$running]" else "[$done]" })
        assertEquals("front_1", await(api).id)
        assertEquals(3, asked("/api/exports"))
    }

    @Test
    fun aJobThatNeverFinishesTimesOut() = runTest {
        val api = api(job = { job("running") })
        val error = failure(api, timeoutMs = 5 * EXPORT_POLL_MS)
        assertEquals("The export took too long; it may still appear in Frigate's Exports", error?.message)
        assertEquals(5, asked("/api/jobs/export/front_1"))
    }
}
