package com.jtn.frigateviewer.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A recording's player: paused in the background and kept through changes of layout. */
@RunWith(RobolectricTestRunner::class)
class VodPlayerTest {
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
                    LocalLifecycleOwner provides owner,
                    LocalVodPlayerFactory provides { context -> ExoPlayer.Builder(context).build().also(players::add) },
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
}
