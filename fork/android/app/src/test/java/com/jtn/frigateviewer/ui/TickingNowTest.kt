package com.jtn.frigateviewer.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Relative times ("just now", "5m ago") move on while they show. */
@RunWith(RobolectricTestRunner::class)
class TickingNowTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** The app's clock, which the test moves on by hand. */
    @Volatile private var clock = System.currentTimeMillis()

    /** An alert that started half a minute before the test did. */
    private val review = """[{"id": "r1", "camera": "driveway", "start_time": ${clock / 1000 - 30}, "end_time": ${clock / 1000 - 20},
        "has_been_reviewed": false, "severity": "alert", "thumb_path": "/t/r1.webp",
        "data": {"objects": ["person"], "zones": [], "audio": []}}]"""

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun show(): AppViewModel = compose.showApp(
        serverRule.server,
        temp.root,
        scope,
        content = { vm -> CompositionLocalProvider(LocalClock provides { clock }) { App(vm) } },
    ) { request ->
        when (request.url.encodedPath) {
            "/api/config" -> json("""{"cameras": {"driveway": {"friendly_name": "Driveway"}}}""")
            "/api/review" -> json(review)
            else -> null
        }
    }

    /** Moves the app's clock and the screen's on by [minutes]. */
    private fun wait(minutes: Int) {
        clock += minutes * MINUTE_MS
        compose.mainClock.advanceTimeBy(minutes * MINUTE_MS)
        compose.waitForIdle()
    }

    @Test
    fun aCameraTileSaysHowLongAgoAsTimePasses() {
        show()
        val justNow = hasContentDescription("Person · just now", substring = true)
        compose.awaitMain { compose.onAllNodes(justNow).fetchSemanticsNodes().isNotEmpty() }

        wait(5)

        compose.onNode(hasContentDescription("Person · 5m ago", substring = true)).assertExists()
    }

    @Test
    fun aCamerasLastActivityMovesOnAsTimePasses() {
        val vm = show()
        compose.runOnIdle { vm.nav.openCamera("driveway") }
        compose.onNodeWithText("now").assertExists()

        wait(5)

        compose.onNodeWithText("5m").assertExists()
    }

    private companion object {
        const val MINUTE_MS = 60_000L
    }
}
