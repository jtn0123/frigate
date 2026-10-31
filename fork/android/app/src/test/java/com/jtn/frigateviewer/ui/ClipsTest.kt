package com.jtn.frigateviewer.ui

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.MediaFiles
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.buildHttpClient
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Saving an item's clip through Frigate's exports, and sharing its snapshot, against a fake server only. */
@RunWith(RobolectricTestRunner::class)
class ClipsTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val reviews = """[{"id": "r1", "camera": "driveway", "start_time": 1700000000.0, "end_time": 1700000020.0,
        "severity": "alert", "thumb_path": "/t.webp", "data": {"objects": ["person"], "detections": ["ev1"], "zones": [], "audio": []}}]"""

    private val clip = byteArrayOf(0, 0, 0, 24, 102, 116, 121, 112)
    private val jpeg = byteArrayOf(-1, -40, -1, -32)

    /** Paths the app asked for, with the method. */
    private val requests = CopyOnWriteArrayList<String>()

    /** Times /api/exports was asked; the export finishes on the second. */
    @Volatile private var polls = 0

    private val media = object : MediaFiles {
        val saved = CopyOnWriteArrayList<Pair<String, ByteArray>>()

        override suspend fun saveVideo(name: String, write: suspend (OutputStream) -> Unit): String {
            val out = ByteArrayOutputStream()
            write(out)
            saved += name to out.toByteArray()
            return "content://media/video/1"
        }

        override suspend fun shareable(name: String, bytes: ByteArray): String {
            saved += name to bytes
            return "content://files/shared/$name"
        }
    }

    private fun show(exportStatus: Int = 202): AppViewModel {
        val vm = compose.showApp(serverRule.server, temp.root, scope, media = media) { request ->
            val path = request.url.encodedPath
            requests += "${request.method} $path"
            when {
                path == "/api/config" -> json("""{"cameras": {"driveway": {"friendly_name": "Drive way!"}}}""")
                path == "/api/review" -> json(reviews)
                path.startsWith("/api/export/") -> json("""{"export_id": "driveway_abc", "status": "queued"}""", code = exportStatus)
                path == "/api/exports" -> {
                    polls++
                    json(
                        """[{"id": "driveway_abc", "camera": "driveway", "name": "x", "in_progress": ${polls < 2},
                        "video_path": "/media/frigate/exports/driveway_abc.mp4"}]""",
                    )
                }
                path == "/exports/driveway_abc.mp4" -> MockResponse.Builder().body(Buffer().write(clip)).build()
                path == "/api/events/ev1/snapshot.jpg" -> MockResponse.Builder().body(Buffer().write(jpeg)).build()
                else -> null
            }
        }
        compose.runOnIdle { vm.openEvent(vm.reviewById("r1")!!) }
        return vm
    }

    @Test
    fun savingAClipExportsItWaitsAndSavesTheFile() {
        val vm = show()

        compose.onNodeWithContentDescription("Save clip").performClick()
        compose.awaitMain(timeoutMs = 15_000) { vm.clips.states["r1"] is ClipState.Saved }

        assertTrue(requests.contains("POST /api/export/driveway/start/1699999995/end/1700000025"))
        val (name, bytes) = media.saved.single()
        assertTrue("Named for the camera and time: $name", name.startsWith("Drive way 20") && name.endsWith(".mp4"))
        assertArrayEquals(clip, bytes)
        compose.onNodeWithText("Saved to Movies/Frigate").assertExists()

        compose.onNodeWithText("Share").performClick()
        compose.runOnIdle { assertEquals(null, vm.clips.share) }
    }

    @Test
    fun aRefusedExportSaysSo() {
        val vm = show(exportStatus = 400)

        compose.onNodeWithContentDescription("Save clip").performClick()
        compose.awaitMain { vm.clips.states["r1"] is ClipState.Failed }

        compose.onNodeWithText("Could not save the clip", substring = true).assertExists()
        assertTrue("Nothing saved", media.saved.isEmpty())
    }

    @Test
    fun sharingASnapshotUsesTheTrackedObjectsSnapshot() {
        show()

        compose.onNodeWithContentDescription("Share snapshot").performClick()
        compose.awaitMain { media.saved.isNotEmpty() }

        assertArrayEquals(jpeg, media.saved.single().second)
        assertTrue(media.saved.single().first.endsWith(".jpg"))
    }

    @Test
    fun aDoubleTapSharesTheSnapshotOnce() {
        serverRule.server.enqueue(MockResponse.Builder().headersDelay(300, TimeUnit.MILLISECONDS).body(Buffer().write(jpeg)).build())
        val api = FrigateApi(buildHttpClient(null, pin = null), serverRule.server.url("/").toString())
        val clips = Clips(scope, onSessionLost = {}, media)
        val item = ReviewItem(id = "r1", camera = "driveway", startTime = 1.0, endTime = 2.0, severity = "alert", thumbPath = "/t.webp")

        val first = clips.shareSnapshot(api, item, "Driveway")
        assertNull("The second tap waits for the first", clips.shareSnapshot(api, item, "Driveway"))
        assertEquals(setOf("r1"), clips.sharingSnapshots)
        runBlocking { first!!.join() }

        assertEquals(1, serverRule.server.requestCount)
        assertEquals(1, media.saved.size)
        assertTrue(clips.sharingSnapshots.isEmpty())
        assertEquals("image/jpeg", clips.share?.mime)
    }

    @Test
    fun namesAreSafeForFiles() {
        assertEquals("Camera", clipName("!!", 0.0).substringBefore(' '))
        assertTrue(clipName("Front/Door", 0.0).startsWith("FrontDoor "))
    }
}
