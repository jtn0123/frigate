package com.jtn.frigateviewer.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
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

/** A recording's player: paused in the background and kept through changes of layout. */
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

    private fun openRecording(): AppViewModel {
        val vm = compose.showApp(
            serverRule.server,
            temp.root,
            scope,
            content = { vm ->
                CompositionLocalProvider(
                    LocalConfiguration provides rotated(LocalConfiguration.current, landscape),
                    LocalLifecycleOwner provides owner,
                    LocalPlayerFactory provides { builder -> builder.build().also(players::add) },
                ) { App(vm) }
            },
        ) { request ->
            if (request.url.encodedPath == "/api/config") json("""{"cameras": {"driveway": {"friendly_name": "Driveway"}}}""") else null
        }
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
}
