package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.CertificateChangedException
import com.jtn.frigateviewer.data.Failure
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Severity
import com.jtn.frigateviewer.data.buildHttpClient
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ReviewStoreTest {
    @get:Rule val serverRule = MockWebServerRule()
    private val server: MockWebServer get() = serverRule.server

    private val sessionLost = mutableListOf<String?>()
    private val store = ReviewStore(CoroutineScope(Dispatchers.Unconfined)) { sessionLost += it }
    private val api by lazy { FrigateApi(buildHttpClient(null, pin = null), server.url("/").toString()) }

    private fun review(id: String, camera: String, severity: String, start: Double, reviewed: Boolean = false) =
        """{"id":"$id","camera":"$camera","start_time":$start,"end_time":${start + 10},
            "has_been_reviewed":$reviewed,"severity":"$severity","thumb_path":"/media/frigate/clips/review/$id.webp"}"""

    /** Newest first, as Frigate returns them. */
    private val sample = listOf(
        review("a3", "front", "alert", 3000.0),
        review("d2", "back", "detection", 2000.0),
        review("a2", "back", "alert", 1500.0, reviewed = true),
        review("a1", "front", "alert", 1000.0),
    ).joinToString(",", "[", "]")

    private fun loadSample() = runBlocking {
        server.enqueue(MockResponse.Builder().body(sample).build())
        store.refresh(api)!!.join()
        server.takeRequest()
    }

    private fun ids() = store.filtered.map { it.id }

    @Test
    fun startsLoadingAndFiltersLocally() {
        assertEquals(Remote.Loading, store.reviews)
        loadSample()

        assertEquals("Alerts are the default", listOf("a3", "a2", "a1"), ids())
        store.severity = Severity.DETECTION
        assertEquals(listOf("d2"), ids())
        store.severity = Severity.ALL
        store.cameraFilter = "back"
        assertEquals(listOf("d2", "a2"), ids())
        assertEquals(listOf("a3", "a1"), store.forCamera("front").map { it.id })
        assertEquals("One fetch serves every filter", 1, server.requestCount)
    }

    @Test
    fun countsOnlyUnreviewedAlerts() {
        loadSample()
        assertEquals(2, store.unreviewedAlerts)
    }

    @Test
    fun markingIsImmediateAndSkipsReviewedItems() = runBlocking {
        loadSample()
        server.enqueue(MockResponse.Builder().body("{}").build())

        store.markReviewed(api, store.filtered)!!.join()

        assertEquals(0, store.unreviewedAlerts)
        assertNull(store.message)
        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("/api/reviews/viewed", request.url.encodedPath)
        assertEquals("""{"ids":["a3","a1"],"reviewed":true}""", request.body?.utf8())
        assertNull("Nothing left to mark", store.markReviewed(api, store.filtered))
    }

    @Test
    fun aRefusedMarkIsUndoneAndReported() = runBlocking {
        loadSample()
        server.enqueue(MockResponse.Builder().code(500).build())

        store.markReviewed(api, store.filtered)!!.join()

        assertEquals("Both alerts are unreviewed again", 2, store.unreviewedAlerts)
        assertTrue("The one reviewed before stays reviewed", store.forCamera("back").first { it.id == "a2" }.reviewed)
        assertEquals("Could not mark 2 items reviewed (HTTP 500 for /api/reviews/viewed)", store.message?.text)
        assertTrue(sessionLost.isEmpty())
        store.messageShown()
        assertNull(store.message)
    }

    @Test
    fun aSwipedMarkOffersUndoWhichUnmarksOnTheServer() = runBlocking {
        loadSample()
        server.enqueue(MockResponse.Builder().body("{}").build())
        server.enqueue(MockResponse.Builder().body("{}").build())

        store.markReviewed(api, store.filtered.take(1), undoable = true)!!.join()
        val notice = store.message!!
        assertEquals(ReviewNotice("Marked reviewed", setOf("a3")), notice)

        store.undo(api, notice)!!.join()

        assertEquals(2, store.unreviewedAlerts)
        server.takeRequest(1, TimeUnit.SECONDS)
        assertEquals("""{"ids":["a3"],"reviewed":false}""", server.takeRequest(1, TimeUnit.SECONDS)!!.body?.utf8())
    }

    @Test
    fun aRefusedUndoLeavesTheItemReviewed() = runBlocking {
        loadSample()
        server.enqueue(MockResponse.Builder().body("{}").build())
        server.enqueue(MockResponse.Builder().code(500).build())
        store.markReviewed(api, store.filtered.take(1), undoable = true)!!.join()

        store.undo(api, store.message!!)!!.join()

        assertEquals(1, store.unreviewedAlerts)
        assertEquals("Could not mark this item unreviewed (HTTP 500 for /api/reviews/viewed)", store.message?.text)
    }

    @Test
    fun aMarkRejectedForAuthSignsOut() = runBlocking {
        loadSample()
        server.enqueue(MockResponse.Builder().code(401).build())
        store.markReviewed(api, store.filtered.take(1))!!.join()
        assertEquals(listOf<String?>(null), sessionLost)
        assertEquals("Could not mark this item reviewed (Session expired, please sign in again)", store.message?.text)
    }

    @Test
    fun keepsTheLastGoodListWhenARefreshFails() = runBlocking {
        loadSample()
        server.enqueue(MockResponse.Builder().code(500).build())

        store.refresh(api)!!.join()

        assertTrue(store.reviews is Remote.Ready)
        assertEquals(3, store.filtered.size)
        assertFalse(store.refreshing)
        assertTrue(sessionLost.isEmpty())
    }

    @Test
    fun showsTheErrorWhenTheFirstLoadFails() = runBlocking {
        server.enqueue(MockResponse.Builder().code(500).build())
        store.refresh(api)!!.join()
        assertEquals(Remote.Failed(Failure.Http(500, "/api/review")), store.reviews)
    }

    @Test
    fun anExpiredSessionSignsOut() = runBlocking {
        server.enqueue(MockResponse.Builder().code(401).build())
        store.refresh(api)!!.join()
        assertEquals(listOf<String?>(null), sessionLost)
        assertTrue(store.reviews is Remote.Failed)
    }

    @Test
    fun resetForgetsTheList() {
        loadSample()
        store.reset()
        assertEquals(Remote.Loading, store.reviews)
        assertTrue(store.filtered.isEmpty())
    }

    @Test
    fun adjacentReviewsFollowNewestFirstOrder() {
        loadSample()
        store.severity = Severity.ALL
        val list = store.filtered
        val (older, newer) = adjacentReviews(list, list[1])
        assertEquals("a2", older?.id)
        assertEquals("a3", newer?.id)
        assertEquals(null to null, adjacentReviews(list.drop(1), list[0]))
        assertNull(adjacentReviews(list, list.last()).first)
        assertNull(adjacentReviews(list, list.first()).second)
    }

    @Test
    fun aFullResponseIsReportedAsCapped() = runBlocking {
        val small = ReviewStore(CoroutineScope(Dispatchers.Unconfined), limit = 4) {}
        server.enqueue(MockResponse.Builder().body(sample).build())
        small.refresh(api)!!.join()
        assertTrue("4 of at most 4 may leave some out", small.capped)
        assertEquals("4", server.takeRequest().url.queryParameter("limit"))

        loadSample()
        assertFalse("4 of at most 1,000 is everything", store.capped)
    }

    @Test
    fun openingMarksOnlyWithTrackingAndAutoMarkOn() = runBlocking {
        loadSample()
        val item = store.byId("a3")!!
        val off = listOf(
            ServerSettings(trackReviews = false, markReviewedOnOpen = true),
            ServerSettings(trackReviews = true, markReviewedOnOpen = false),
            ServerSettings(trackReviews = false, markReviewedOnOpen = false),
        )
        off.forEach { settings -> assertNull("$settings should not mark", store.opened(api, item, settings)) }
        assertFalse(store.byId("a3")!!.reviewed)
        assertEquals("Nothing was sent to the server", 1, server.requestCount)

        server.enqueue(MockResponse.Builder().body("{}").build())
        store.opened(api, item, ServerSettings(trackReviews = true, markReviewedOnOpen = true))!!.join()
        assertTrue(store.byId("a3")!!.reviewed)
        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("/api/reviews/viewed", request.url.encodedPath)
        assertEquals("""{"ids":["a3"],"reviewed":true}""", request.body?.utf8())
    }

    @Test
    fun aResetDropsTheRunningRefreshSoTheNextSessionLoadsItsOwn() = runBlocking {
        server.enqueue(MockResponse.Builder().headersDelay(500, TimeUnit.MILLISECONDS).body(sample).build())
        server.enqueue(MockResponse.Builder().body("[${review("n1", "front", "alert", 4000.0)}]").build())
        val old = store.refresh(api)!!
        server.takeRequest()

        store.reset()
        assertFalse("The new session is not left waiting on the old refresh", store.refreshing)
        val fresh = store.refresh(api)
        assertNotNull("The new session's refresh runs", fresh)
        fresh!!.join()
        old.join()

        assertEquals(listOf("n1"), ids())
        assertFalse(store.refreshing)
        assertTrue(sessionLost.isEmpty())
    }
}

class LoadRemoteTest {
    private val sessionLost = mutableListOf<String?>()

    @Test
    fun aChangedCertificateSignsOutWithTheReason() = runBlocking {
        val failure = IOException("connect failed").apply { addSuppressed(CertificateChangedException("AA", "BB")) }
        val result = loadRemote({ sessionLost += it }) { throw failure }
        assertEquals(listOf<String?>(CERTIFICATE_CHANGED), sessionLost)
        assertEquals(Remote.Failed(Failure.CertificateChanged), result)
    }

    @Test
    fun anOrdinaryFailureKeepsTheSession() = runBlocking {
        val result = loadRemote({ sessionLost += it }) { throw java.net.ConnectException("refused") }
        assertTrue(sessionLost.isEmpty())
        assertEquals(Remote.Failed(Failure.Offline), result)
    }

    @Test
    fun aReplyThatIsNotFrigatesFails() = runBlocking {
        val result = loadRemote({ sessionLost += it }) { FrigateApi.parseConfig("<html>") }
        assertEquals(Remote.Failed(Failure.BadResponse), result)
        assertTrue(sessionLost.isEmpty())
    }

    @Test(expected = IllegalStateException::class)
    fun aBugIsNotShownAsAConnectionProblem(): Unit = runBlocking {
        loadRemote({ sessionLost += it }) { error("bug") }
    }
}
