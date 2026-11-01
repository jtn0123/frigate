package com.jtn.frigateviewer.data

import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test

/** Replies are decoded, and sorted, on the request's IO thread rather than the caller's. */
class DecodeTest {
    @get:Rule val serverRule = MockWebServerRule()
    private val server: MockWebServer get() = serverRule.server

    private fun api() = FrigateApi(buildHttpClient(null, pin = null), server.url("/").toString())

    @Test
    fun repliesAreDecodedOnTheRequestThreadNotTheCallers() {
        server.enqueue(MockResponse.Builder().body("[]").build())
        val caller = Executors.newSingleThreadExecutor { Thread(it, "caller") }
        try {
            val decodedOn = runBlocking {
                withContext(caller.asCoroutineDispatcher()) {
                    api().getBody(api().url("api/labels")) { Thread.currentThread().name }
                }
            }
            assertNotEquals("caller", decodedOn)
        } finally {
            caller.shutdown()
        }
    }

    @Test
    fun reviewsAreSortedNewestFirst() = runBlocking {
        val item = """{"id": "%s", "camera": "c", "start_time": %s, "severity": "alert", "thumb_path": "",
            "data": {"objects": [], "detections": [], "zones": [], "audio": []}}"""
        server.enqueue(MockResponse.Builder().body("[${item.format("old", "1.0")}, ${item.format("new", "2.0")}]").build())
        assertEquals(listOf("new", "old"), api().reviews().map { it.id })
    }
}
