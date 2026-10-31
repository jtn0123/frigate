package com.jtn.frigateviewer.ui

import android.os.Looper
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.lifecycle.SavedStateHandle
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.ServerSettings
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** Whole-app states that are hard to reach by hand: a refused mark and a restored screen whose item is gone. */
@RunWith(RobolectricTestRunner::class)
class AppScreenTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val storeScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val review = """
        [{"id": "r1", "camera": "driveway", "start_time": 1700000000.0, "end_time": 1700000010.0,
          "has_been_reviewed": false, "severity": "alert", "thumb_path": "/media/frigate/clips/review/r1.webp",
          "data": {"objects": ["person"], "zones": [], "audio": []}}]
    """.trimIndent()

    @After
    fun tearDown() {
        storeScope.cancel()
    }

    /** Bodies sent to mark items, in order. */
    private val marks = CopyOnWriteArrayList<String>()

    /** The app signed in to a fake Frigate, which answers marking with [markStatus] and the list with [reviewStatus]. */
    private fun show(saved: SavedStateHandle = SavedStateHandle(), markStatus: Int = 500, reviewStatus: Int = 200): AppViewModel {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/config" -> MockResponse.Builder().body("""{"cameras": {}}""").build()
                "/api/review" -> MockResponse.Builder().code(reviewStatus).body(review).build()
                "/api/reviews/viewed" -> {
                    marks += request.body?.utf8().orEmpty()
                    MockResponse.Builder().code(markStatus).body("{}").build()
                }
                else -> MockResponse.Builder().body("0.17.0").build()
            }
        }
        val store = testSettingsStore(File(temp.root, "server.preferences_pb"), storeScope)
        runBlocking { store.save(ServerSettings(baseUrl = serverRule.server.url("/").toString())) }
        val vm = AppViewModel(saved, store)
        compose.setContent { App(vm) }
        awaitMain { vm.reviews !is Remote.Loading }
        return vm
    }

    @Test
    fun aRefusedMarkIsShownAndUndone() {
        val vm = show()
        val item = (vm.reviews as Remote.Ready<List<ReviewItem>>).value.single()

        compose.runOnIdle { vm.markReviewed(item) }

        awaitMain { compose.onAllNodes(hasText("Could not mark", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        compose.runOnIdle { check(!vm.reviewById("r1")!!.reviewed) { "The item is unreviewed again" } }
    }

    @Test
    fun swipingARowMarksItReviewedAndUndoPutsItBack() {
        val vm = show(markStatus = 200)
        compose.runOnIdle { vm.nav.tab = Tab.REVIEW }

        compose.onNode(hasContentDescription("not reviewed", substring = true)).performTouchInput { swipeLeft() }

        awaitMain { compose.onAllNodes(hasText("Marked reviewed")).fetchSemanticsNodes().isNotEmpty() }
        compose.runOnIdle { check(vm.reviewById("r1")!!.reviewed) { "Reviewed at once" } }
        assertTrue(marks.single().contains("\"reviewed\":true"))

        compose.onNodeWithText("Undo").performClick()

        awaitMain { marks.size == 2 }
        assertTrue(marks.last().contains("\"reviewed\":false"))
        compose.runOnIdle { check(!vm.reviewById("r1")!!.reviewed) { "Unreviewed again" } }
    }

    @Test
    fun anEmptyFilteredListOffersToShowEveryCamera() {
        val vm = show()
        compose.runOnIdle {
            vm.nav.tab = Tab.REVIEW
            vm.cameraFilter = "garage"
        }

        compose.onNodeWithText("No alerts on garage").assertExists()
        compose.onNodeWithText("Show all cameras").performScrollTo().performClick()

        compose.runOnIdle { check(vm.cameraFilter == null) { "The filter is cleared" } }
        compose.onNode(hasContentDescription("not reviewed", substring = true)).assertExists()
    }

    @Test
    fun aListThatFailedToLoadSaysWhyAndRetries() {
        val vm = show(reviewStatus = 500)
        compose.runOnIdle { vm.nav.tab = Tab.REVIEW }

        compose.onNodeWithText("Couldn't load this").assertExists()
        val before = serverRule.server.requestCount
        compose.onNodeWithText("Retry").performScrollTo().performClick()

        awaitMain { serverRule.server.requestCount > before }
    }

    @Test
    fun aRestoredEventThatIsGoneSaysSoAndGoesBack() {
        val saved = SavedStateHandle(mapOf("overlays" to encodeOverlays(listOf(Overlay.Event("gone")))))

        val vm = show(saved)

        compose.onNodeWithText("This is no longer available").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("This is no longer available").assertDoesNotExist()
        compose.runOnIdle { check(vm.nav.overlays.isEmpty()) { "Back at the tabs" } }
    }

    /**
     * Waits for [condition], running the main looper meanwhile: the view model's
     * work resumes there after each request, and the test thread is the main thread.
     */
    private fun awaitMain(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "Timed out" }
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        compose.waitForIdle()
    }

    private companion object {
        const val TIMEOUT_MS = 5_000L
    }
}
