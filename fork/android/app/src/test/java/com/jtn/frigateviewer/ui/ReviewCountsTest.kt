package com.jtn.frigateviewer.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.Severity
import com.jtn.frigateviewer.data.buildHttpClient
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The Review tab's counts are worked out when the list or filters change, not as its times move on. */
@RunWith(RobolectricTestRunner::class)
class ReviewCountsTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    /** The app's clock, which the test moves on by hand. */
    @Volatile private var clock = 0L

    private fun review(id: String, camera: String, severity: String, start: Long, reviewed: Boolean = false) =
        """{"id":"$id","camera":"$camera","start_time":$start,"end_time":${start + 10},
            "has_been_reviewed":$reviewed,"severity":"$severity","thumb_path":"/t/$id.webp",
            "data":{"objects":["person"],"zones":[],"audio":[]}}"""

    /** Newest first, as Frigate returns them. */
    private fun sample(start: Long) = listOf(
        review("a3", "front", "alert", start + 30),
        review("d2", "back", "detection", start + 20),
        review("a2", "back", "alert", start + 15, reviewed = true),
        review("a1", "front", "alert", start),
    ).joinToString(",", "[", "]")

    @Test
    fun countsFollowTheCameraAndSeverity() {
        val store = ReviewStore(CoroutineScope(Dispatchers.Unconfined)) {}
        val api = FrigateApi(buildHttpClient(null, pin = null), serverRule.server.url("/").toString())
        serverRule.server.enqueue(MockResponse.Builder().body(sample(1_000)).build())
        runBlocking { store.refresh(api)!!.join() }

        // Severity counts are of the chosen camera's items; unreviewed, of those shown.
        assertEquals(ReviewCounts(alerts = 3, detections = 1, all = 4, unreviewed = 2), store.counts)
        assertSame("Read again, not counted again", store.counts, store.counts)
        store.cameraFilter = "back"
        assertEquals(ReviewCounts(alerts = 1, detections = 1, all = 2, unreviewed = 0), store.counts)
        store.severity = Severity.ALL
        assertEquals(ReviewCounts(alerts = 1, detections = 1, all = 2, unreviewed = 1), store.counts)
    }

    @Test
    fun theMinutesTickLeavesTheCountsAlone() {
        // Two minutes before midnight, with alerts from the minute before that, so the tick shows on the day's label.
        val midnight = LocalDate.now().plusDays(1).atStartOfDay(ZoneId.systemDefault()).toEpochSecond()
        clock = (midnight - 120) * 1_000
        val vm = compose.showApp(
            serverRule.server,
            temp.root,
            scope,
            content = { vm -> CompositionLocalProvider(LocalClock provides { clock }) { App(vm) } },
        ) { request ->
            when (request.url.encodedPath) {
                "/api/config" -> json("""{"cameras": {"front": {}, "back": {}}}""")
                "/api/review" -> json(sample(midnight - 180))
                else -> null
            }
        }
        compose.runOnIdle { vm.nav.tab = Tab.REVIEW }
        compose.onNodeWithText("Today · 3").assertExists()
        val counts = compose.runOnIdle { vm.reviewCounts }

        clock += THREE_MINUTES_MS
        compose.mainClock.advanceTimeBy(THREE_MINUTES_MS)

        compose.onNodeWithText("Yesterday · 3").assertExists()
        compose.runOnIdle { assertSame(counts, vm.reviewCounts) }
        compose.onNodeWithText("Alerts 3").assertExists()
    }

    private companion object {
        const val THREE_MINUTES_MS = 3 * 60_000L
    }
}
