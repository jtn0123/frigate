package com.jtn.frigateviewer.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import com.jtn.frigateviewer.data.ReviewItem
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.HttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Scrubbing a camera's day and playing from the chosen point. */
@RunWith(RobolectricTestRunner::class)
class TimelineScreenTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val now = System.currentTimeMillis() / 1000

    /** Two alerts, 2 and 1 hours ago, newest first like Frigate lists them. */
    private val reviews = listOf("late" to now - 3600, "early" to now - 7200).joinToString(prefix = "[", postfix = "]") { (id, at) ->
        """{"id": "$id", "camera": "driveway", "start_time": $at.0, "end_time": ${at + 20}.0, "severity": "alert",
            "thumb_path": "/t.webp", "data": {"objects": ["person"], "zones": [], "audio": []}}"""
    }

    /** The recordings requests the screen made, in order. */
    private val asked = CopyOnWriteArrayList<HttpUrl>()

    private fun show(start: Long, recordings: (RecordedRequest) -> MockResponse? = { null }): AppViewModel {
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            val path = request.url.encodedPath
            when {
                path.startsWith("/api/driveway/recordings") -> recordings(request).also { asked += request.url }
                path == "/api/config" -> json("""{"cameras": {"driveway": {"friendly_name": "Driveway"}}}""")
                path == "/api/review" -> json(reviews)
                path == "/api/review/activity/motion" -> json("""[{"start_time": ${now - 600}.0, "motion": 40, "camera": "driveway"}]""")
                else -> null
            }
        }
        compose.runOnIdle { vm.nav.push(Overlay.Timeline("driveway", start)) }
        compose.awaitMain { compose.onAllNodes(hasContentDescription("Timeline")).fetchSemanticsNodes().isNotEmpty() }
        return vm
    }

    /** The time under the playhead, as the timeline tells a screen reader. */
    private fun at(): String = compose.onNodeWithContentDescription("Timeline").fetchSemanticsNode()
        .config[SemanticsProperties.StateDescription].substringAfter("At ").substringBefore(",")

    private fun clock(time: Long) = formatClock(time.toDouble())

    @Test
    fun itPlaysFromWhereItOpens() {
        show(now - 900)

        assertEquals(clock(now - 900), at())
        compose.onNodeWithText(clock(now - 900)).assertExists()
    }

    @Test
    fun eventButtonsJumpToTheNeighboringAlerts() {
        show(now - 900)

        compose.onNodeWithText("Earlier event").performScrollTo().performClick()
        assertEquals("Five seconds before the later alert", clock(now - 3605), at())

        compose.onNodeWithText("Earlier event").performScrollTo().performClick()
        assertEquals(clock(now - 7205), at())

        compose.onNodeWithText("Later event").performScrollTo().performClick()
        assertEquals(clock(now - 3605), at())
    }

    @Test
    fun draggingTheStripPlaysFromWhereItIsLetGo() {
        show(now - 7000)

        compose.onNodeWithContentDescription("Timeline").performScrollTo().performTouchInput { swipeLeft() }
        compose.waitForIdle()

        assertNotEquals("Dragging moves the playhead", clock(now - 7000), at())
    }

    @Test
    fun screenReadersCanStepThroughTime() {
        show(now - 7000)

        val node = compose.onNodeWithContentDescription("Timeline").performScrollTo().fetchSemanticsNode()
        val back = node.config[SemanticsActions.CustomActions].first { it.label == "Back 5 minutes" }
        compose.runOnIdle { back.action() }

        assertEquals(clock(now - 7300), at())
    }

    /** Recorded for 100 seconds from 7000 seconds ago, then nothing for 900 seconds, then 1000 seconds more. */
    private val recorded = listOf(now - 7000.0 to now - 6900.0, now - 6000.0 to now - 5000.0)

    /** The coverage timeline the server realizes for a request: the recordings cut to its range. */
    private fun coverage(request: RecordedRequest): MockResponse {
        val after = request.url.queryParameter("after")!!.toDouble()
        val before = request.url.queryParameter("before")!!.toDouble()
        val spans = recorded.filter { (start, end) -> end > after && start < before }.joinToString { (start, end) ->
            val from = maxOf(start, after)
            val to = minOf(end, before)
            """{"start_time": $from, "end_time": $to, "duration": ${((to - from) * 1000).toLong()}}"""
        }
        return json("""{"spans": [], "codecs_compatible": true, "timelines": {"auto": [$spans], "main": [], "sub": []}}""")
    }

    private fun awaitAt(time: Long) = compose.awaitMain { at() == clock(time) }

    @Test
    fun openingInAGapStartsAtTheNextRecording() {
        show(now - 6500, ::coverage)

        awaitAt(now - 6000)
        compose.onNodeWithText(clock(now - 6000)).assertExists()
        val request = asked.single()
        assertEquals("One call for the range", "/api/driveway/recordings/coverage", request.encodedPath)
        assertEquals("${now - 6500}", request.queryParameter("after"))
    }

    @Test
    fun steppingIntoAGapPlaysFromTheNextRecording() {
        show(now - 7000, ::coverage)
        awaitAt(now - 7000)

        val node = compose.onNodeWithContentDescription("Timeline").performScrollTo().fetchSemanticsNode()
        val forward = node.config[SemanticsActions.CustomActions].first { it.label == "Forward 5 minutes" }
        compose.runOnIdle { forward.action() }

        awaitAt(now - 6000)
    }

    @Test
    fun aServerWithoutCoverageIsReadFromItsRecordings() {
        show(now - 6500) { request ->
            if (request.url.encodedPath.endsWith("/coverage")) {
                json("""{"detail": "Not Found"}""", code = 404)
            } else {
                json("""[{"start_time": ${now - 6100}.0, "end_time": ${now - 5000}.0, "duration": 1100.0}]""")
            }
        }

        awaitAt(now - 6100)
    }

    @Test
    fun withoutItsRecordingsTheTimelineCountsOnFromWhereItStarts() {
        show(now - 6500) { json("{}", code = 500) }
        compose.awaitMain { asked.isNotEmpty() }

        assertEquals(clock(now - 6500), at())
    }

    @Test
    fun neighborsSkipTheOnePlaying() {
        val items = listOf(100.0, 200.0).map { ReviewItem(id = "$it", camera = "c", startTime = it, severity = "alert", thumbPath = "") }

        assertEquals(100.0, previousReview(items, 195)!!.startTime, 0.0)
        assertNull("The one just started is not earlier", previousReview(items, 104))
        assertEquals(200.0, nextReview(items, 150)!!.startTime, 0.0)
        assertNull(nextReview(items, 200))
        assertNull("Not the one it is waiting to start", nextReview(items, 195))
    }

    @Test
    fun neighborsAreFoundWithoutWalkingTheWholeList() {
        val items = (0 until 10_000).map {
            ReviewItem(id = "$it", camera = "c", startTime = it * 100.0, severity = "alert", thumbPath = "")
        }
        var reads = 0
        val counting = object : AbstractList<ReviewItem>() {
            override val size = items.size

            override fun get(index: Int): ReviewItem {
                reads++
                return items[index]
            }
        }

        assertEquals("4999", previousReview(counting, 500_000)?.id)
        assertEquals("5001", nextReview(counting, 500_000)?.id)
        assertTrue("A binary search, not a filter of every item, at each step: $reads reads", reads < 64)
    }
}
