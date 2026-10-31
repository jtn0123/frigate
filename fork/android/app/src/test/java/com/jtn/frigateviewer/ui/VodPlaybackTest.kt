package com.jtn.frigateviewer.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

/** A recording's player: paused in the background and kept through changes of layout. */
// Real text layout, so a long title takes the width it would on a phone.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
class VodPlaybackTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** Every player the screens made, in order. */
    private val players = mutableListOf<ExoPlayer>()

    private val owner = object : LifecycleOwner {
        val registry = LifecycleRegistry(this).apply { currentState = Lifecycle.State.RESUMED }
        override val lifecycle: Lifecycle get() = registry
    }

    /** Whether the phone is held sideways, as the screens see it. */
    private var landscape by mutableStateOf(false)

    @After
    fun tearDown() {
        scope.cancel()
    }

    /** The camera's name as the server gives it. */
    @Volatile private var label = "Driveway"

    /** The one alert the server lists, in progress until [ended]. */
    @Volatile private var ended = false

    private fun review(): String {
        val end = if (ended) "1700000060.0" else "null"
        return """[{"id": "r1", "camera": "driveway", "start_time": 1700000000.0, "end_time": $end,
            "has_been_reviewed": false, "severity": "alert", "thumb_path": "/t/r1.webp",
            "data": {"objects": ["person"], "zones": [], "audio": []}}]"""
    }

    private fun show(): AppViewModel = compose.showApp(
        serverRule.server,
        temp.root,
        scope,
        content = { vm ->
            CompositionLocalProvider(
                LocalLifecycleOwner provides owner,
                LocalPlayerFactory provides { builder -> builder.build().also(players::add) },
            ) { Phone(landscape) { App(vm) } }
        },
    ) { request ->
        when (request.url.encodedPath) {
            "/api/config" -> json("""{"cameras": {"driveway": {"friendly_name": "$label"}}}""")
            "/api/review" -> json(review())
            else -> null
        }
    }

    private fun openRecording(): AppViewModel {
        val vm = show()
        compose.runOnIdle { vm.nav.openRecording("driveway", 15) }
        compose.waitForIdle()
        return vm
    }

    @Test
    fun aRecordingPausesInTheBackgroundAndPlaysOnWhenTheAppReturns() {
        openRecording()
        val player = compose.runOnIdle { players.single() }
        assertTrue(compose.runOnIdle { player.playWhenReady })

        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.CREATED }
        assertFalse(compose.runOnIdle { player.playWhenReady })

        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }
        assertTrue(compose.runOnIdle { player.playWhenReady })
    }

    @Test
    fun aRecordingPausedBeforeLeavingStaysPausedOnReturn() {
        openRecording()
        val player = compose.runOnIdle { players.single() }
        compose.runOnIdle { player.pause() }

        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.CREATED }
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }

        assertFalse(compose.runOnIdle { player.playWhenReady })
    }

    @Test
    fun turningThePhoneKeepsTheSamePlayer() {
        openRecording()
        compose.onNodeWithContentDescription("Fullscreen").assertExists()

        compose.runOnIdle { landscape = true }
        compose.onNodeWithContentDescription("Exit fullscreen").assertExists()
        compose.runOnIdle { landscape = false }
        compose.onNodeWithContentDescription("Fullscreen").assertExists()

        assertEquals(1, compose.runOnIdle { players.size })
    }

    @Test
    fun anAlertEndingWhileItPlaysKeepsItsPlayer() {
        val vm = show()
        compose.runOnIdle { vm.openEvent(vm.reviewById("r1")!!) }
        compose.waitForIdle()
        assertEquals(1, compose.runOnIdle { players.size })

        ended = true
        compose.runOnIdle { vm.refreshReviews() }
        compose.awaitMain { vm.reviewById("r1")?.endTime != null }

        assertEquals(1, compose.runOnIdle { players.size })
    }

    @Test
    fun aLongTitleInFullscreenStopsShortOfTheExitButton() {
        label = "The camera over the side gate by the garden shed, looking down the drive"
        landscape = true
        openRecording()

        val title = compose.onNodeWithText(label).fetchSemanticsNode().boundsInRoot
        val exit = compose.onNodeWithContentDescription("Exit fullscreen").fetchSemanticsNode().boundsInRoot
        assertTrue("The title ends before the button", title.right <= exit.left)
    }
}
