package com.jtn.frigateviewer.ui

import android.net.Uri
import android.view.View
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.hasAnySibling
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import androidx.test.core.app.ApplicationProvider
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** What a screen shows when its data does not load, rather than looking quiet or empty. */
@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class FailureStatesTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val config = """{"cameras": {"driveway": {"friendly_name": "Driveway"}, "garage": {}}}"""

    @Test
    fun aFailedMotionFetchSaysSoAndRetries() {
        val fail = AtomicBoolean(true)
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            when (request.url.encodedPath) {
                "/api/config" -> json(config)
                "/api/review/activity/motion" ->
                    if (fail.get()) json("{}", code = 500) else json("""[{"start_time": 1.0, "motion": 4, "camera": "driveway"}]""")
                else -> null
            }
        }
        compose.runOnIdle { vm.nav.push(Overlay.Timeline("driveway", System.currentTimeMillis() / 1000 - 600)) }
        compose.awaitText("Motion unavailable")

        fail.set(false)
        // The motion line's, not the player's: the fake server has no recording either.
        compose.onNode(hasText("Retry") and hasAnySibling(hasText("Motion unavailable"))).performScrollTo().performClick()

        compose.awaitMain { compose.onAllNodes(hasText("Motion unavailable")).fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun theLiveGridSaysWhenCamerasFailAndRetries() {
        val fail = AtomicBoolean(true)
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            if (request.url.encodedPath == "/api/config") (if (fail.get()) json("{}", code = 500) else json(config)) else null
        }
        compose.runOnIdle { vm.nav.push(Overlay.LiveGrid()) }
        compose.awaitText("Couldn't load this")

        fail.set(false)
        compose.onNodeWithText("Retry").performClick()

        compose.awaitMain { compose.onAllNodes(hasContentDescription("Choose cameras")).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun theLiveGridSaysWhenThereAreNoCameras() {
        val vm = compose.showApp(serverRule.server, temp.root, scope)
        compose.runOnIdle { vm.nav.push(Overlay.LiveGrid()) }
        compose.onNodeWithText("No cameras to show").assertExists()
    }

    @Test
    fun healthKeepsItsFiguresWhenItsScreenOpensAgain() {
        val stats = javaClass.classLoader!!.getResource("stats.json")!!.readText()
        val fail = AtomicBoolean(false)
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            if (request.url.encodedPath == "/api/stats") (if (fail.get()) json("{}", code = 500) else json(stats)) else null
        }
        compose.runOnIdle { vm.nav.push(Overlay.Health) }
        compose.awaitText("3d 4h")
        compose.runOnIdle { vm.nav.back() }

        // Turning the phone, or coming back to the screen, shows what the view model kept.
        fail.set(true)
        compose.runOnIdle { vm.nav.push(Overlay.Health) }
        compose.onNodeWithText("3d 4h").assertExists()
    }

    @Test
    fun aRecordingThatWillNotPlaySaysWhyInPlainWordsAndRetries() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext()).build()
        val playback = VodPlayback(player)
        compose.setContent { VodVideo(playback) }

        compose.runOnIdle { playback.error = UiText.Plain("The server could not send this recording.") }
        compose.onNodeWithText("The server could not send this recording.").assertExists()
        compose.onNodeWithText("Retry").performClick()

        compose.runOnIdle { assertNull(playback.error) }
        compose.onNodeWithText("The server could not send this recording.").assertDoesNotExist()
        compose.runOnIdle { player.release() }
    }

    @Test
    fun aRecordingErrorTakesThePlaceOfThePlayerControls() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext()).build()
        val playback = VodPlayback(player)
        lateinit var root: View
        compose.setContent {
            root = LocalView.current
            VodVideo(playback, Modifier.size(360.dp, 203.dp))
        }
        val playerView = compose.runOnIdle { root.findPlayerView()!! }
        compose.runOnIdle { assertTrue("Controls while it plays", playerView.useController) }

        compose.runOnIdle { playback.error = UiText.Plain("The server could not send this recording.") }
        compose.runOnIdle { assertFalse("No controls under the error", playerView.useController) }
        val retry = compose.onNodeWithText("Retry").fetchSemanticsNode().boundsInRoot
        val density = compose.density.density
        assertTrue("Retry is at least 48dp tall", retry.height / density >= 48f)
        compose.onNodeWithText("Retry").assertHasClickAction()

        compose.onNodeWithText("Retry").performClick()
        compose.runOnIdle { assertTrue("Controls back once it plays again", playerView.useController) }
        compose.runOnIdle { player.release() }
    }

    private fun View.findPlayerView(): PlayerView? = when (this) {
        is PlayerView -> this
        is ViewGroup -> (0 until childCount).firstNotNullOfOrNull { getChildAt(it).findPlayerView() }
        else -> null
    }

    private fun httpError(code: Int) = PlaybackException(
        "bad status",
        HttpDataSource.InvalidResponseCodeException(code, null, null, emptyMap(), DataSpec(Uri.EMPTY), ByteArray(0)),
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
    )

    @Test
    fun playbackErrorsAreWordedForPeople() {
        assertEquals("This recording is not on the server.", playbackError(httpError(404)).english())
        assertEquals("The server refused this recording.", playbackError(httpError(403)).english())
        assertEquals("The server could not send this recording.", playbackError(httpError(500)).english())
        assertEquals(
            "The server could not put this clip together. It may still be saving, so try again in a moment.",
            playbackError(httpError(502)).english(),
        )
        assertEquals(
            "Could not connect to the server.",
            playbackError(PlaybackException("down", IOException(), PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)).english(),
        )
        val decoding = playbackError(PlaybackException("bad", null, PlaybackException.ERROR_CODE_DECODING_FAILED)).english()
        assertEquals("This recording could not be played.", decoding)
        assertFalse("No raw error code names", "ERROR_CODE" in decoding)
    }
}
