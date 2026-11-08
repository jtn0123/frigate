package com.jtn.frigateviewer.ui

import android.graphics.Bitmap
import android.os.Looper
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.media3.exoplayer.ExoPlayer
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Session
import java.io.ByteArrayOutputStream
import java.time.Duration
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.GraphicsMode

/** The picture under live video: only as tall as it shows, light to hold, and slower once the video gives up. */
// Real bitmaps, so pictures are decoded as on a phone.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
class LiveSnapshotTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    /** Every player the video made, in order. */
    private val players = mutableListOf<ExoPlayer>()

    /** The height each picture was asked for, in order. */
    private val heights = ConcurrentLinkedQueue<Int>()

    private val snapshots = Snapshots()

    @Volatile private var state = LiveState.CONNECTING

    /** A camera's picture, as Frigate sends it. */
    private val jpeg: ByteArray = ByteArrayOutputStream().also {
        Bitmap.createBitmap(16, 9, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 90, it)
    }.toByteArray()

    @Test
    fun aPictureDecodesAtTwoBytesAPixel() {
        val frame = runBlocking { decodeFrame(jpeg) }

        assertEquals(Bitmap.Config.RGB_565, frame?.asAndroidBitmap()?.config)
    }

    @Test
    fun thePictureIsAsTallAsItShowsAndSlowsOnceTheVideoGivesUp() {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = if (request.url.encodedPath == "/api/driveway/latest.jpg") {
                request.url.queryParameter("h")?.toIntOrNull()?.let(heights::add)
                MockResponse.Builder().body(Buffer().write(jpeg)).build()
            } else {
                // The stream is refused, so each player fails until the video gives up.
                MockResponse.Builder().code(404).build()
            }
        }
        val session = Session(ServerSettings(baseUrl = serverRule.server.url("/").toString()), onTokenRenewed = {})
        // Time stands still unless the test moves it.
        compose.mainClock.autoAdvance = false
        compose.setContent {
            CompositionLocalProvider(
                LocalSnapshots provides snapshots,
                LocalPlayerFactory provides { builder -> builder.build().also(players::add) },
            ) { LiveVideo(session, "driveway", "driveway", muted = true, Modifier.size(320.dp, TILE_HEIGHT)) { state = it } }
        }
        val asked = snapshotHeight(with(compose.density) { TILE_HEIGHT.roundToPx() })
        assertTrue("A small view asks for less than the largest picture", asked < snapshotHeight(Int.MAX_VALUE))

        awaitVideo { snapshots["driveway"].frame != null }
        assertEquals(CONNECTING_SNAPSHOT_MS, snapshots["driveway"].intervalMs)
        assertEquals(Bitmap.Config.RGB_565, snapshots["driveway"].frame?.asAndroidBitmap()?.config)

        awaitVideo { state == LiveState.FAILED && snapshots["driveway"].intervalMs == FAILED_SNAPSHOT_MS }
        assertEquals("Every picture as tall as the view, not larger", listOf(asked), heights.distinct())
        assertEquals(LiveRetry.MAX_RETRIES + 1, compose.runOnIdle { players.size })
    }

    /**
     * Runs the main looper, where the players' own retries wait, and moves the screen's clock on
     * a tenth of a second at a time, where the reconnects and pictures wait, until [condition].
     */
    private fun awaitVideo(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (!compose.runOnIdle(condition)) {
            check(System.currentTimeMillis() < deadline) { "Timed out" }
            Thread.sleep(10)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(STEP_MS))
            compose.mainClock.advanceTimeBy(STEP_MS)
        }
    }

    private companion object {
        const val TIMEOUT_MS = 15_000L
        const val STEP_MS = 100L
        val TILE_HEIGHT = 120.dp
    }
}
