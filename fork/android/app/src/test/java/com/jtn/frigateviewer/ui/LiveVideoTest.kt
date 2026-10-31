package com.jtn.frigateviewer.ui

import android.os.Looper
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.exoplayer.ExoPlayer
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Session
import java.time.Duration
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** Live video reconnects after a failure only while the app is on screen. */
@RunWith(RobolectricTestRunner::class)
class LiveVideoTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    /** Every player the video made, in order. */
    private val players = mutableListOf<ExoPlayer>()

    private val owner = object : LifecycleOwner {
        val registry = LifecycleRegistry(this).apply { currentState = Lifecycle.State.RESUMED }
        override val lifecycle: Lifecycle get() = registry
    }

    @Test
    fun aFailureJustBeforeLeavingWaitsForTheAppToReturn() {
        // The stream is refused, so the first player fails and a reconnect is due.
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = MockResponse.Builder().code(404).build()
        }
        val session =
            Session(ServerSettings(baseUrl = serverRule.server.url("/").toString()), onTokenRenewed = {}, onCertificatePinned = {})
        // Time stands still unless the test moves it, so the reconnect's wait cannot pass unseen.
        compose.mainClock.autoAdvance = false
        compose.setContent {
            CompositionLocalProvider(
                LocalLifecycleOwner provides owner,
                LocalPlayerFactory provides { builder -> builder.build().also(players::add) },
            ) { LiveVideo(session, "driveway", "driveway", muted = true) }
        }
        compose.mainClock.advanceTimeByFrame()
        awaitFailure()

        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.CREATED }
        compose.mainClock.advanceTimeBy(LiveRetry.RETRY_DELAY_MS * 2)
        assertEquals("No new player in the background", 1, compose.runOnIdle { players.size })

        compose.runOnIdle { owner.registry.currentState = Lifecycle.State.RESUMED }
        compose.mainClock.advanceTimeByFrame()
        assertEquals("A fresh one on return", 2, compose.runOnIdle { players.size })
    }

    /** Runs the main looper, without moving the screen's clock, until the first player has failed. */
    private fun awaitFailure() {
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (players.firstOrNull()?.playerError == null) {
            check(System.currentTimeMillis() < deadline) { "Timed out" }
            Thread.sleep(10)
            // The player's own retries wait on this looper's clock.
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        }
    }

    private companion object {
        const val TIMEOUT_MS = 5_000L
    }
}
