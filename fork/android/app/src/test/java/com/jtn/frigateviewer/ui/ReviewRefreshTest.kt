package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.buildHttpClient
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Catching up with recent changes rather than fetching the whole day again, and
 * the per-camera summaries the camera tiles show. Time is virtual, read by the
 * store through its clock.
 */
class ReviewRefreshTest {
    @get:Rule val serverRule = MockWebServerRule()
    private val server: MockWebServer get() = serverRule.server

    private val api by lazy { FrigateApi(buildHttpClient(null, pin = null), server.url("/").toString()) }

    private fun review(id: String, camera: String, severity: String, start: Long, end: Long? = start + 10, reviewed: Boolean = false) =
        """{"id":"$id","camera":"$camera","start_time":$start.0,"end_time":${end?.let { "$it.0" } ?: "null"},
            "has_been_reviewed":$reviewed,"severity":"$severity","thumb_path":"/t/$id.webp"}"""

    private fun list(vararg items: String) = items.joinToString(",", "[", "]")

    private val sample = list(
        review("a3", "front", "alert", BASE - 100, end = null),
        review("d2", "back", "detection", BASE - 200),
        review("a2", "back", "alert", BASE - 300, reviewed = true),
        review("a1", "front", "alert", BASE - 400),
    )

    private fun reply(body: String) = server.enqueue(MockResponse.Builder().body(body).build())

    private fun TestScope.newStore(recentLimit: Int = RECENT_LIMIT) =
        ReviewStore(backgroundScope, clock = { BASE * 1000 + testScheduler.currentTime }, recentLimit = recentLimit) {}

    /** A store holding [sample], fetched whole at virtual time zero. */
    private suspend fun TestScope.loaded(recentLimit: Int = RECENT_LIMIT): ReviewStore {
        val store = newStore(recentLimit)
        reply(sample)
        store.refresh(api)!!.join()
        server.takeRequest()
        return store
    }

    private fun ReviewStore.ids() = (reviews as Remote.Ready).value.map { it.id }

    private fun RecordedRequest.param(name: String) = url.queryParameter(name)

    @Test
    fun aCatchUpAsksOnlyForWhatChangedSinceTheNewestAndMergesIt() = runTest {
        val store = loaded()
        reply(list(review("a3", "front", "alert", BASE - 100, end = BASE - 50), review("n4", "back", "alert", BASE - 20)))

        delay(MIN_GAP_MS)
        store.refreshRecent(api)!!.join()

        val request = server.takeRequest()
        assertEquals("From the newest held, less the overlap", "${BASE - 100 - OVERLAP_SECONDS}", request.param("after"))
        assertEquals("$RECENT_LIMIT", request.param("limit"))
        assertEquals("New first, the rest kept in order", listOf("n4", "a3", "d2", "a2", "a1"), store.ids())
        assertEquals("The end of the one in progress came in", (BASE - 50).toDouble(), store.byId("a3")!!.endTime!!, 0.0)
        assertFalse(store.refreshing)
    }

    @Test
    fun aRunOfReconnectsAsksOnce() = runTest {
        val store = loaded()
        reply("[]")

        val first = store.refreshRecent(api)
        repeat(4) { assertNull("Folded into the one waiting", store.refreshRecent(api)) }
        first!!.join()

        assertEquals("The whole fetch and one catch-up", 2, server.requestCount)
        assertEquals("It waited out the gap since the last fetch", MIN_GAP_MS, testScheduler.currentTime)
    }

    @Test
    fun oneAskedForWhileACatchUpIsOnItsWayAsksAgainAfterIt() = runTest {
        val store = loaded()
        delay(MIN_GAP_MS)
        server.enqueue(MockResponse.Builder().headersDelay(300, TimeUnit.MILLISECONDS).body("[]").build())
        reply(list(review("n4", "back", "alert", BASE - 20)))

        val job = store.refreshRecent(api)!!
        runCurrent()
        server.takeRequest()
        // Something may have changed after that request was sent.
        assertNull(store.refreshRecent(api))
        job.join()

        assertEquals(3, server.requestCount)
        assertEquals("n4", store.ids().first())
    }

    @Test
    fun aCatchUpTakesTheWholeListOnceTheLastWholeOneIsOld() = runTest {
        val store = loaded()
        reply(list(review("a1", "front", "alert", BASE - 400)))

        delay(FULL_EVERY_MS)
        store.refreshRecent(api)!!.join()

        assertEquals("${FrigateApi.REVIEW_LIMIT}", server.takeRequest().param("limit"))
        assertEquals("What the server no longer has is gone", listOf("a1"), store.ids())
    }

    @Test
    fun aDeletedItemStaysUntilTheNextWholeFetch() = runTest {
        val store = loaded()
        // a1 was deleted on the server; a catch-up only sees recent items, so it cannot tell.
        reply("[]")
        delay(MIN_GAP_MS)
        store.refreshRecent(api)!!.join()
        assertTrue("a1" in store.ids())

        reply(list(review("a3", "front", "alert", BASE - 100, end = null)))
        store.refresh(api)!!.join()
        assertEquals(listOf("a3"), store.ids())
    }

    @Test
    fun aFullPageMeansMoreChangedSoTheWholeListFollows() = runTest {
        val store = loaded(recentLimit = 2)
        reply(list(review("n5", "front", "alert", BASE - 10), review("n4", "back", "alert", BASE - 20)))
        reply(
            list(
                review("n5", "front", "alert", BASE - 10),
                review("n4", "back", "alert", BASE - 20),
                review(
                    "n3",
                    "back",
                    "alert",
                    BASE - 30,
                ),
            ),
        )

        delay(MIN_GAP_MS)
        store.refreshRecent(api)!!.join()

        server.takeRequest()
        assertEquals("${FrigateApi.REVIEW_LIMIT}", server.takeRequest().param("limit"))
        assertEquals(listOf("n5", "n4", "n3"), store.ids())
    }

    @Test
    fun aCatchUpWithNothingHeldTakesTheWholeList() = runTest {
        val store = newStore()
        reply(sample)
        store.refreshRecent(api)!!.join()
        assertEquals("${FrigateApi.REVIEW_LIMIT}", server.takeRequest().param("limit"))
        assertEquals(4, store.ids().size)
    }

    @Test
    fun aFailedCatchUpKeepsTheList() = runTest {
        val store = loaded()
        server.enqueue(MockResponse.Builder().code(500).build())
        delay(MIN_GAP_MS)
        store.refreshRecent(api)!!.join()
        assertEquals(listOf("a3", "d2", "a2", "a1"), store.ids())
    }

    @Test
    fun itemsPastTheDayAreDroppedWhenMerging() = runTest {
        val store = newStore()
        reply(list(review("new", "front", "alert", BASE - 100), review("old", "front", "alert", BASE - DAY + 5, end = BASE - DAY + 15)))
        store.refresh(api)!!.join()
        reply("[]")

        delay(MIN_GAP_MS)
        store.refreshRecent(api)!!.join()

        assertEquals("It ended more than 24 hours ago by now", listOf("new"), store.ids())
    }

    @Test
    fun pullingToRefreshDropsAWaitingCatchUp() = runTest {
        val store = loaded()
        val waiting = store.refreshRecent(api)!!
        reply(sample)
        store.refresh(api)!!.join()
        assertTrue(waiting.isCancelled)
        assertEquals("Only the two whole fetches", 2, server.requestCount)
    }

    @Test
    fun aMarkOnItsWayIsNotUndoneByAFetchThatCrossesIt() = runTest {
        val store = loaded()
        server.enqueue(MockResponse.Builder().headersDelay(300, TimeUnit.MILLISECONDS).body("{}").build())
        reply(sample)

        val marking = store.markReviewed(api, listOf(store.byId("a1")!!))!!
        runCurrent()
        server.takeRequest()
        // The server answers with the list from before the mark landed.
        store.refresh(api)!!.join()
        assertTrue("Still shown as marked", store.byId("a1")!!.reviewed)
        marking.join()
        assertTrue(store.byId("a1")!!.reviewed)
    }

    @Test
    fun eachCameraHasItsCountAndLatestItem() = runTest {
        val store = loaded()

        assertEquals(CameraSummary(2, store.byId("a3")), store.summaries["front"])
        assertEquals("a2 is reviewed and d2 is a detection", CameraSummary(0, store.byId("d2")), store.summaries["back"])
        assertNull("A camera with nothing has no entry", store.summaries["garage"])
        assertEquals(listOf("a3", "a1"), store.forCamera("front").map { it.id })
    }

    @Test
    fun summariesAreWorkedOutOncePerChangeOfTheList() = runTest {
        val store = loaded()
        val before = store.summaries
        assertSame("Reading again does not filter again", before, store.summaries)
        assertSame(store.forCamera("front"), store.forCamera("front"))

        store.upsert(store.byId("d2")!!.copy(endTime = (BASE - 150).toDouble()))

        val after = store.summaries
        assertNotNull(after)
        assertTrue(after !== before)
        assertEquals("A change on one camera leaves the other's equal", before["front"], after["front"])
    }

    private companion object {
        /** Now, in epoch seconds, when virtual time is zero. */
        const val BASE = 1_000_000L
        const val DAY = 86_400L
    }
}
