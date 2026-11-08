package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** What changes on a camera's screen without being looked at is read out by TalkBack, and its video is named. */
@RunWith(RobolectricTestRunner::class)
class AnnouncementsTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun SemanticsNodeInteraction.liveRegion() = fetchSemanticsNode().config.getOrNull(SemanticsProperties.LiveRegion)

    @Test
    fun aStatusPillReadsOutEachNewStatus() {
        var label by mutableStateOf("CONNECTING")
        compose.setContent { LivePill(label, live = label == "LIVE", announce = true) }
        assertEquals(LiveRegionMode.Polite, compose.onNodeWithText("CONNECTING").liveRegion())

        label = "LIVE"

        assertEquals(LiveRegionMode.Polite, compose.onNodeWithText("LIVE").liveRegion())
    }

    @Test
    fun aTilesActivityTagIsNotReadOutOnItsOwn() {
        // Every camera tile has one, and a grid of them would talk over each other.
        compose.setContent { LivePill("PERSON", live = true) }
        assertNull(compose.onNodeWithText("PERSON").liveRegion())
    }

    @Test
    fun theCameraScreenNamesItsVideoAndReadsOutItsStatus() {
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            when (request.url.encodedPath) {
                // No live stream for the camera, so its screen shows snapshots.
                "/api/config" -> json("""{"cameras": {"driveway": {"friendly_name": "Driveway"}}, "go2rtc": {"streams": {}}}""")
                else -> null
            }
        }
        compose.runOnIdle { vm.nav.openCamera("driveway") }

        compose.onNodeWithContentDescription("Live view of Driveway").assert(
            SemanticsMatcher("opens larger") { it.config.getOrNull(SemanticsActions.OnClick)?.label == "Show larger" },
        )
        assertEquals(LiveRegionMode.Polite, compose.onNodeWithText("SNAPSHOT").liveRegion())
    }
}
