package com.jtn.frigateviewer.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Live video keeps its connection when the layout around it changes. */
@RunWith(RobolectricTestRunner::class)
class LiveLayoutTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** Every player the screens made, in order. */
    private val players = mutableListOf<ExoPlayer>()

    private var landscape by mutableStateOf(false)

    private val config = """{"cameras": {"driveway": {"friendly_name": "Driveway"}, "porch": {"friendly_name": "Porch"}}}"""

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun show(): Pair<AppViewModel, PipController> {
        val pip = PipController(compose.activity)
        val vm = compose.showApp(
            serverRule.server,
            temp.root,
            scope,
            content = { vm ->
                CompositionLocalProvider(
                    LocalPip provides pip,
                    LocalPlayerFactory provides { builder -> builder.build().also(players::add) },
                ) { Phone(landscape) { App(vm) } }
            },
        ) { request ->
            when (request.url.encodedPath) {
                "/api/config" -> json(config)
                // A stream that connects and stays quiet, so no player fails and is retried.
                "/live/mse/api/ws" -> MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {}).build()
                else -> null
            }
        }
        return vm to pip
    }

    private fun playerCount() = compose.runOnIdle { players.size }

    @Test
    fun theFloatingWindowAndTurningThePhoneKeepTheCamerasStream() {
        val (vm, pip) = show()
        compose.runOnIdle { vm.nav.openCamera("driveway") }
        compose.awaitMain { players.size == 1 }

        compose.runOnIdle { pip.inPip = true }
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        compose.runOnIdle { pip.inPip = false }
        compose.onNodeWithContentDescription("Fullscreen").assertExists()
        compose.runOnIdle { landscape = true }
        compose.onNodeWithContentDescription("Exit fullscreen").assertExists()
        compose.runOnIdle { landscape = false }
        compose.onNodeWithContentDescription("Fullscreen").assertExists()

        assertEquals(1, playerCount())
    }

    @Test
    fun turningThePhoneKeepsTheGridsStreams() {
        val (vm, _) = show()
        compose.runOnIdle { vm.nav.push(Overlay.LiveGrid()) }
        compose.awaitMain { players.size == 2 }
        compose.onNodeWithContentDescription("Choose cameras").assertExists()

        compose.runOnIdle { landscape = true }
        compose.onNodeWithContentDescription("Choose cameras").assertDoesNotExist()
        compose.runOnIdle { landscape = false }
        compose.onNodeWithContentDescription("Choose cameras").assertExists()

        assertEquals(2, playerCount())
    }
}
