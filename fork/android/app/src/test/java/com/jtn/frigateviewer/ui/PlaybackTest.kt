package com.jtn.frigateviewer.ui

import android.content.Context
import android.media.AudioManager
import android.net.Uri
import android.os.Looper
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import androidx.test.core.app.ApplicationProvider
import com.jtn.frigateviewer.data.AuthException
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Session
import java.io.IOException
import java.time.Duration
import java.util.concurrent.TimeUnit
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * Video keeps the screen on only while it plays, shares the sound with other
 * apps, carries a recording on from where it was, and ends a session the
 * server no longer accepts.
 */
@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class PlaybackTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    /** Every player the screen made, in order. */
    private val players = mutableListOf<ExoPlayer>()

    /** How many times the session was ended. */
    private var lost = 0

    private fun session() = Session(ServerSettings(baseUrl = serverRule.server.url("/").toString()), onTokenRenewed = {})

    /** The server answers everything with [code]. */
    private fun answer(code: Int) {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = MockResponse.Builder().code(code).build()
        }
    }

    /** The server takes its time, so a player stays loading. */
    private fun hang() {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                MockResponse.Builder().headersDelay(30, TimeUnit.SECONDS).build()
        }
    }

    @Test
    fun onlyAnUnauthorizedAnswerEndsTheSession() {
        assertTrue(refusesSession(ExoPlaybackException.createForSource(AuthException("401"), 0)))
        assertTrue(refusesSession(httpError(401)))
        assertFalse("A permission, not the login", refusesSession(httpError(403)))
        assertFalse(refusesSession(httpError(500)))
        assertFalse(refusesSession(IOException("down")))
    }

    @Test
    fun anExpiredLoginIsWordedAsOneAndAForbiddenRecordingAsRefused() {
        assertEquals("Session expired, please sign in again", playbackError(httpError(401)).english())
        assertEquals("The server refused this recording.", playbackError(httpError(403)).english())
    }

    @Test
    fun isPlayingFollowsThePlayer() {
        val player = FakePlayer()
        var playing: Boolean? = null
        compose.setContent { playing = rememberIsPlaying(player) }
        compose.runOnIdle { assertEquals(false, playing) }

        compose.runOnIdle { player.playing = true }
        idleMain()
        compose.runOnIdle { assertEquals(true, playing) }

        compose.runOnIdle { player.playing = false }
        idleMain()
        compose.runOnIdle { assertEquals(false, playing) }
    }

    @Test
    fun aPausedOrFailedRecordingLetsTheScreenTimeOut() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext()).build()
        val playback = VodPlayback(player)
        lateinit var root: View
        compose.setContent {
            root = LocalView.current
            VodVideo(playback)
        }
        val view = compose.runOnIdle { root.find<PlayerView>()!! }
        compose.runOnIdle { assertFalse("Not playing", view.keepScreenOn) }
        compose.runOnIdle { playback.error = UiText.Plain("down") }
        compose.runOnIdle { assertFalse("Failed", view.keepScreenOn) }
        compose.runOnIdle { player.release() }
    }

    @Test
    fun liveVideoThatIsNotPlayingYetLetsTheScreenTimeOut() {
        hang()
        lateinit var root: View
        compose.setContent {
            root = LocalView.current
            Live(session(), muted = true)
        }
        compose.runOnIdle { assertFalse(root.find<TextureView>()!!.keepScreenOn) }
    }

    @Test
    fun aRecordingCarriesOnFromWhereItWasWhenItsPlayerIsMadeAgain() {
        hang()
        val session = session()
        val url = serverRule.server.url("/vod/clip/index.m3u8").toString()
        val restoration = StateRestorationTester(compose)
        var playback: VodPlayback? = null
        restoration.setContent {
            CompositionLocalProvider(LocalPlayerFactory provides { it.build().also(players::add) }) {
                playback = rememberVodPlayback(session, url)
            }
        }
        val first = compose.runOnIdle { playback!!.player.also { it.seekTo(42_000) } }

        // As after a dark mode change, or coming back from another screen.
        restoration.emulateSavedInstanceStateRestore()

        compose.runOnIdle {
            val again = playback!!.player
            assertNotSame("A new player", first, again)
            assertEquals(42_000L, again.currentPosition)
        }
    }

    @Test
    fun anUnauthorizedRecordingEndsTheSession() {
        answer(401)
        val playback = showRecording()
        awaitError()
        compose.runOnIdle {
            assertEquals(1, lost)
            assertEquals("Session expired, please sign in again", playback.error?.english())
        }
    }

    @Test
    fun aForbiddenRecordingKeepsTheSession() {
        answer(403)
        val playback = showRecording()
        awaitError()
        compose.runOnIdle {
            assertEquals(0, lost)
            assertEquals("The server refused this recording.", playback.error?.english())
        }
    }

    @Test
    fun unauthorizedLiveVideoEndsTheSession() {
        answer(401)
        compose.setContent { Live(session(), muted = true) }
        awaitError()
        // Here nothing signs out, so the video retries and is refused again.
        compose.runOnIdle { assertTrue("Ended, not just retried", lost > 0) }
    }

    @Test
    fun forbiddenLiveVideoKeepsTheSession() {
        answer(403)
        compose.setContent { Live(session(), muted = true) }
        awaitError()
        compose.runOnIdle { assertEquals(0, lost) }
    }

    @Test
    fun mutedLiveVideoLeavesOtherAppsTheirSoundAndUnmutedTakesIt() {
        hang()
        val muted = mutableStateOf(true)
        compose.setContent { Live(session(), muted = muted.value) }
        compose.runOnIdle {
            val player = players.single()
            player.awaitPlaybackThread()
            assertEquals(C.USAGE_MEDIA, player.audioAttributes.usage)
            assertEquals(C.AUDIO_CONTENT_TYPE_MOVIE, player.audioAttributes.contentType)
            assertNull("A muted tile asks for nothing", audio().lastAudioFocusRequest)
        }

        compose.runOnIdle { muted.value = false }
        compose.runOnIdle {
            players.single().awaitPlaybackThread()
            assertTrue("Sound asks for focus", audio().lastAudioFocusRequest != null)
        }
    }

    @Test
    fun aRecordingAsksForTheSound() {
        hang()
        showRecording()
        compose.runOnIdle {
            players.single().awaitPlaybackThread()
            assertEquals(C.USAGE_MEDIA, players.single().audioAttributes.usage)
            assertTrue(audio().lastAudioFocusRequest != null)
        }
    }

    @Composable
    private fun Live(session: Session, muted: Boolean) {
        CompositionLocalProvider(
            LocalPlayerFactory provides { it.build().also(players::add) },
            LocalSessionLost provides { lost++ },
        ) { LiveVideo(session, "driveway", "driveway", muted = muted) }
    }

    private fun showRecording(): VodPlayback {
        val session = session()
        val url = serverRule.server.url("/vod/clip/index.m3u8").toString()
        var playback: VodPlayback? = null
        compose.setContent {
            CompositionLocalProvider(
                LocalPlayerFactory provides { it.build().also(players::add) },
                LocalSessionLost provides { lost++ },
            ) { playback = rememberVodPlayback(session, url) }
        }
        return compose.runOnIdle { playback!! }
    }

    private fun audio() = shadowOf(
        ApplicationProvider.getApplicationContext<Context>().getSystemService(Context.AUDIO_SERVICE) as AudioManager,
    )

    /** Runs the main looper until the first player has failed. */
    private fun awaitError() {
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (players.firstOrNull()?.playerError == null) {
            check(System.currentTimeMillis() < deadline) { "Timed out" }
            Thread.sleep(10)
            idleMain()
        }
        compose.waitForIdle()
    }

    /**
     * Waits until the player's playback thread has handled everything sent to
     * it so far. Audio focus is requested there, not on the main thread, so a
     * check straight after the effect that changed it could run first.
     */
    private fun ExoPlayer.awaitPlaybackThread() {
        createMessage { _, _ -> }.send().blockUntilDelivered(TIMEOUT_MS)
    }

    private fun idleMain() = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))

    private inline fun <reified T : View> View.find(): T? = all().filterIsInstance<T>().firstOrNull()

    private fun View.all(): Sequence<View> = sequence {
        yield(this@all)
        if (this@all is ViewGroup) (0 until childCount).forEach { yieldAll(getChildAt(it).all()) }
    }

    private fun httpError(code: Int) = PlaybackException(
        "bad status",
        HttpDataSource.InvalidResponseCodeException(code, null, null, emptyMap(), DataSpec(Uri.EMPTY), ByteArray(0)),
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
    )

    /** A player that plays when told, with nothing to load. */
    private class FakePlayer : SimpleBasePlayer(Looper.getMainLooper()) {
        var playing = false
            set(value) {
                field = value
                invalidateState()
            }

        override fun getState(): State = State.Builder()
            .setAvailableCommands(Player.Commands.Builder().addAllCommands().build())
            .setPlaylist(listOf(MediaItemData.Builder("clip").setMediaItem(MediaItem.EMPTY).build()))
            .setPlayWhenReady(playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setPlaybackState(if (playing) Player.STATE_READY else Player.STATE_IDLE)
            .build()
    }

    private companion object {
        const val TIMEOUT_MS = 5_000L
    }
}
