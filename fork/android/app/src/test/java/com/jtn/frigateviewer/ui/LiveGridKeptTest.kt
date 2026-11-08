package com.jtn.frigateviewer.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.exoplayer.ExoPlayer
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A camera opened from the grid keeps the grid's streams open beneath it for a while, and no longer. */
@RunWith(RobolectricTestRunner::class)
class LiveGridKeptTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** Every player the screens made, in order. */
    private val players = mutableListOf<ExoPlayer>()

    /** The go2rtc stream each live connection asked for, in order. */
    private val streams = ConcurrentLinkedQueue<String>()

    /** The camera each picture was asked for, in order. */
    private val pictures = ConcurrentLinkedQueue<String>()

    private val owner = object : LifecycleOwner {
        val registry = LifecycleRegistry(this).apply { currentState = Lifecycle.State.RESUMED }
        override val lifecycle: Lifecycle get() = registry
    }

    private val names = listOf("a", "b", "c", "d")

    // The lighter stream listed first, so taking the last would play the full one.
    private val config = names.joinToString(prefix = """{"cameras": {""", postfix = "}}") {
        """"$it": {"friendly_name": "Cam ${it.uppercase()}", "live": {"streams": {"Sub": "${it}_sub", "Main": "$it"}}}"""
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun show(): AppViewModel = compose.showApp(
        serverRule.server,
        temp.root,
        scope,
        content = { vm ->
            CompositionLocalProvider(
                LocalLifecycleOwner provides owner,
                LocalPlayerFactory provides { builder -> builder.build().also(players::add) },
            ) { App(vm) }
        },
    ) { request ->
        val path = request.url.encodedPath
        when {
            path == "/api/config" -> json(config)
            // A stream that connects and stays quiet, so no player fails and is retried.
            path == "/live/mse/api/ws" -> {
                request.url.queryParameter("src")?.let(streams::add)
                MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {}).build()
            }
            path.endsWith("/latest.jpg") -> {
                pictures.add(path.removePrefix("/api/").substringBefore('/'))
                null
            }
            else -> null
        }
    }

    private fun hasClickLabel(label: String) =
        SemanticsMatcher("click label $label") { it.config.getOrNull(SemanticsActions.OnClick)?.label == label }

    /** Opens the grid, waits for its first pictures, then opens camera A from it. */
    private fun openGridThenCamera(vm: AppViewModel) {
        compose.runOnIdle { vm.nav.push(Overlay.LiveGrid()) }
        compose.awaitMain { players.size == GRID && names.all { vm.snapshots[it].checkedAt > 0 } }
        compose.onNode(hasClickLabel("Open Cam A")).assertExists()
        compose.runOnIdle { vm.nav.openCamera("a") }
        compose.awaitMain { players.size == GRID + 1 }
    }

    private fun gridPlayers() = compose.runOnIdle { players.take(GRID) }

    private fun picturesOtherThanA() = pictures.count { it != "a" }

    @Test
    fun backFromACameraFindsTheGridStillStreaming() {
        val vm = show()
        openGridThenCamera(vm)
        assertEquals("Each tile on its lighter stream", names.map { "${it}_sub" }.toSet(), streams.take(GRID).toSet())
        // Underneath, the grid takes no touches and says nothing.
        compose.onNode(hasClickLabel("Open Cam B")).assertDoesNotExist()

        compose.runOnIdle { vm.nav.back() }

        compose.onNode(hasClickLabel("Open Cam B")).assertExists()
        compose.runOnIdle {
            assertEquals("No tile connected again", GRID + 1, players.size)
            assertTrue("The camera's own player is let go", players.last().isReleased)
        }
        assertTrue(gridPlayers().none { it.isReleased })
    }

    @Test
    fun aCoveredGridAsksForNoPictures() {
        val vm = show()
        openGridThenCamera(vm)
        val before = picturesOtherThanA()
        val cameraBefore = pictures.count { it == "a" }

        compose.mainClock.advanceTimeBy(CONNECTING_SNAPSHOT_MS * 2)
        // The camera on top refreshes on the same clock, so by its next picture any tile's would have come too.
        compose.awaitMain { pictures.count { it == "a" } > cameraBefore }

        assertEquals(before, picturesOtherThanA())
        compose.runOnIdle { vm.nav.back() }
        compose.awaitMain { picturesOtherThanA() > before }
    }

    @Test
    fun theGridLetsItsStreamsGoAfterHalfAMinuteUnderACamera() {
        val vm = show()
        openGridThenCamera(vm)

        compose.mainClock.advanceTimeBy(GRID_KEPT_MS - 1_000)
        assertTrue("Still kept just before", gridPlayers().none { it.isReleased })
        compose.mainClock.advanceTimeBy(1_000)
        assertTrue(gridPlayers().all { it.isReleased })
        compose.runOnIdle { assertFalse("The camera plays on", players[GRID].isReleased) }

        compose.runOnIdle { vm.nav.back() }

        compose.awaitMain { players.size == 2 * GRID + 1 }
        compose.onNode(hasClickLabel("Open Cam B")).assertExists()
    }

    @Test
    fun leavingTheAppLetsTheCoveredGridGo() {
        val vm = show()
        openGridThenCamera(vm)

        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.CREATED }
        assertTrue(gridPlayers().all { it.isReleased })

        // Back in the app the camera connects again; back from it the grid connects anew.
        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }
        compose.awaitMain { players.size == GRID + 2 }
        compose.runOnIdle { vm.nav.back() }
        compose.awaitMain { players.size == 2 * GRID + 2 }
        compose.runOnIdle { assertEquals(GRID, players.count { !it.isReleased }) }
    }

    private companion object {
        const val GRID = 4
    }
}
