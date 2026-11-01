package com.jtn.frigateviewer.ui

import android.graphics.Bitmap
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

/** Each camera's latest picture, and marking one that has stopped coming as offline. */
// Real bitmaps, so pictures are made and decoded as on a phone.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
class SnapshotsTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Volatile private var now = 1_000_000L

    private val picture = ImageBitmap(1, 1)

    @Test
    fun aPictureThatStopsComingIsMarkedOfflineAfterTwoIntervals() = runTest {
        val down = AtomicBoolean(false)
        val snapshots = Snapshots(clock = { now }, decode = { picture })
        val following = launch {
            snapshots.follow("yard", intervalMs = 5_000) { if (down.get()) throw IOException("down") else byteArrayOf(1) }
        }
        runCurrent()
        assertSame(picture, snapshots["yard"].frame)
        assertNull(snapshots["yard"].staleMs)

        down.set(true)
        now += 5_000
        advanceTimeBy(5_001)
        assertSame("The last picture stays up", picture, snapshots["yard"].frame)
        assertNull("One missed refresh is not offline yet", snapshots["yard"].staleMs)

        now += 7_000
        advanceTimeBy(5_000)
        assertEquals(12_000L, snapshots["yard"].staleMs)
        assertEquals("Offline, 12s", offlineLabel(12_000))

        down.set(false)
        now += 5_000
        advanceTimeBy(5_000)
        assertNull("A new picture is live again", snapshots["yard"].staleMs)
        following.cancel()
    }

    @Test
    fun withoutAPictureAFailureIsNotOfflineButUnavailable() = runTest {
        val snapshots = Snapshots(clock = { now }, decode = { picture })
        snapshots.refresh("yard", 1_000) { throw IOException("down") }
        now += 60_000
        snapshots.refresh("yard", 1_000) { throw IOException("down") }

        assertTrue(snapshots["yard"].failed)
        assertNull(snapshots["yard"].staleMs)
    }

    @Test
    fun offlineAgesReadShortly() {
        assertEquals("Offline, 2m", offlineLabel(150_000))
        assertEquals("Offline, 3h", offlineLabel(3 * 3_600_000L + 5))
        assertEquals("Offline, 2d", offlineLabel(2 * 86_400_000L))
    }

    @Test
    fun resetForgetsThePictures() = runTest {
        val snapshots = Snapshots(clock = { now }, decode = { picture })
        snapshots.refresh("yard", 1_000) { byteArrayOf(1) }
        snapshots.reset()
        assertNull(snapshots["yard"].frame)
    }

    /** A real image, which the app decodes like a camera's. */
    private val png: ByteArray = ByteArrayOutputStream().also {
        Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, it)
    }.toByteArray()

    @Test
    fun aCameraTileSaysItsPictureIsOffline() {
        val down = AtomicBoolean(false)
        val snapshots = Snapshots(clock = { now })
        val vm = compose.showApp(serverRule.server, temp.root, scope, snapshots = snapshots) { request ->
            when (request.url.encodedPath) {
                "/api/config" -> json("""{"cameras": {"driveway": {"friendly_name": "Driveway"}}}""")
                "/api/driveway/latest.jpg" ->
                    if (down.get()) json("{}", code = 503) else MockResponse.Builder().body(Buffer().write(png)).build()
                else -> null
            }
        }
        compose.awaitMain { vm.snapshots["driveway"].frame != null }
        fun description() = compose.onNode(hasContentDescription("Driveway", substring = true)).fetchSemanticsNode()
            .config[SemanticsProperties.ContentDescription].single()
        assertTrue(description(), "offline" !in description())

        down.set(true)
        now += 90_000
        compose.mainClock.advanceTimeBy(5_000)
        // The tile's own description replaces its children's, so the tag on the picture is said this way.
        compose.awaitMain { vm.snapshots["driveway"].staleMs != null && "offline" in description() }
        assertTrue(description(), description().startsWith("Driveway, picture offline, 1m"))
    }
}
