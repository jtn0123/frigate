package com.jtn.frigateviewer.work

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.workDataOf
import com.jtn.frigateviewer.AppContainer
import com.jtn.frigateviewer.FrigateApp
import com.jtn.frigateviewer.data.ClipRequest
import com.jtn.frigateviewer.data.Failure
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.MediaFiles
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.buildHttpClient
import com.jtn.frigateviewer.ui.ClipState
import com.jtn.frigateviewer.ui.json
import com.jtn.frigateviewer.ui.testSettingsStore
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** Saving a clip in the background with WorkManager, against a fake Frigate. */
@RunWith(RobolectricTestRunner::class)
class ClipWorkerTest {
    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val clip = byteArrayOf(0, 0, 0, 24, 102, 116, 121, 112)
    private val request = ClipRequest("r1", "driveway", 1_699_999_995, 1_700_000_025, "Driveway 2023-11-14 22.13.20")

    /** Paths asked for, with the method. */
    private val asked = CopyOnWriteArrayList<String>()

    /** What the export's job says. */
    @Volatile private var job = """{"status": "success"}"""

    private val saved = CopyOnWriteArrayList<Pair<String, ByteArray>>()

    private val media = object : MediaFiles {
        override suspend fun saveVideo(name: String, write: suspend (OutputStream) -> Unit): String {
            val out = ByteArrayOutputStream()
            write(out)
            saved += name to out.toByteArray()
            return "content://media/external/video/media/7"
        }

        override suspend fun shareable(name: String, bytes: ByteArray): String = error("Not shared here")
    }

    @Before
    fun setUp() {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                asked += "${request.method} $path"
                return when {
                    path.startsWith("/api/export/") -> json("""{"export_id": "driveway_abc", "status": "queued"}""", code = 202)
                    path.startsWith("/api/jobs/export/") -> json(job)
                    path.startsWith("/api/exports/") -> json(
                        """{"id": "${path.substringAfterLast('/')}", "in_progress": false,
                        "video_path": "/media/frigate/exports/driveway_abc.mp4"}""",
                    )
                    path == "/exports/driveway_abc.mp4" -> MockResponse.Builder().body(Buffer().write(clip)).build()
                    else -> json("{}", code = 404)
                }
            }
        }
        val store = testSettingsStore(File(temp.root, "server.preferences_pb"), scope)
        runBlocking { store.save(ServerSettings(baseUrl = serverRule.server.url("/").toString())) }
        ApplicationProvider.getApplicationContext<FrigateApp>().container = AppContainer(store, media, { null }, {})
    }

    @After
    fun tearDown() {
        scope.cancel()
        // The test WorkManager's database, for the tests that made one.
        if (::manager.isInitialized) WorkManagerTestInitHelper.closeWorkDatabase()
    }

    private fun allowNotifications() {
        shadowOf(context as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun worker(id: UUID = UUID.randomUUID()) =
        TestListenableWorkerBuilder<ClipWorker>(context).setId(id).setInputData(request.toData()).build()

    /** The notification posted for the item, as its text. */
    private fun posted(): List<String> = shadowOf(context.getSystemService(NotificationManager::class.java)).allNotifications
        .map { it.extras.getCharSequence("android.text").toString() }

    @Test
    fun aSavedClipIsNotifiedAndItsUriGivenToTheScreens() {
        allowNotifications()

        val result = runBlocking { worker().doWork() }

        assertEquals(ListenableWorker.Result.success(workDataOf(ClipWorker.KEY_URI to "content://media/external/video/media/7")), result)
        assertEquals("${request.name}.mp4", saved.single().first)
        assertArrayEquals(clip, saved.single().second)
        assertTrue(asked.contains("POST /api/export/driveway/start/1699999995/end/1700000025"))
        assertEquals(listOf("Saved to Movies/Frigate"), posted())
    }

    @Test
    fun aClipThatCouldNotBeMadeIsNotifiedWithTheServersReason() {
        allowNotifications()
        job = """{"status": "failed", "error_message": "No recordings found"}"""

        val result = runBlocking { worker().doWork() }

        assertTrue(result is ListenableWorker.Result.Failure)
        val failure = failureOf((result as ListenableWorker.Result.Failure).outputData)
        assertEquals(Failure.Other("The server could not make the clip (No recordings found)"), failure)
        assertEquals(listOf("Could not save the clip (The server could not make the clip (No recordings found))"), posted())
        assertTrue("Nothing saved", saved.isEmpty())
    }

    @Test
    fun withoutThePermissionTheClipStillSavesQuietly() {
        val result = runBlocking { worker().doWork() }

        assertTrue(result is ListenableWorker.Result.Success)
        assertEquals(1, saved.size)
        assertEquals("Nothing posted without the permission", emptyList<String>(), posted())
        assertTrue(ClipNotifications(context).askable)
        allowNotifications()
        assertFalse(ClipNotifications(context).askable)
    }

    @Test
    fun workStartedAgainWaitsForTheExportItStarted() {
        val id = UUID.randomUUID()
        context.getSharedPreferences(ClipWorker.EXPORTS, Context.MODE_PRIVATE).edit().putString(id.toString(), "driveway_earlier").commit()

        runBlocking { worker(id).doWork() }

        assertTrue("No second export: $asked", asked.none { it.startsWith("POST /api/export/") })
        assertTrue(asked.contains("GET /api/jobs/export/driveway_earlier"))
        assertFalse("Forgotten once done", context.getSharedPreferences(ClipWorker.EXPORTS, Context.MODE_PRIVATE).contains(id.toString()))
    }

    @Test
    fun signedOutTheWorkFailsAsSessionExpired() {
        runBlocking { ApplicationProvider.getApplicationContext<FrigateApp>().container.settingsStore.clearSession() }

        val result = runBlocking { worker().doWork() }

        assertEquals(Failure.SessionExpired, failureOf((result as ListenableWorker.Result.Failure).outputData))
        assertTrue(asked.isEmpty())
    }

    @Test
    fun failuresSurviveTheirTripThroughWorkData() {
        val failures = listOf(Failure.Offline, Failure.SessionExpired, Failure.Http(500, "/api/export"), Failure.Other("detail"))
        failures.forEach { assertEquals(it, failureOf(it.toData())) }
        assertEquals(request, clipRequestOf(request.toData()))
    }

    private lateinit var manager: WorkManager

    /** WorkManager as the app has it, running work on the test's threads once its network is there. */
    private fun useWorkManager(): WorkClipJobs {
        allowNotifications()
        val config = Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
        manager = WorkManager.getInstance(context)
        return WorkClipJobs(context)
    }

    private val api get() = FrigateApi(buildHttpClient(null, null), serverRule.server.url("/").toString())

    /** The work saving [itemId]'s clip, once it is enqueued. */
    private fun enqueued(itemId: String): WorkInfo = runBlocking {
        withTimeout(TIMEOUT_MS) { manager.getWorkInfosForUniqueWorkFlow("clip-$itemId").first { it.isNotEmpty() }.single() }
    }

    /** The network [work] waits for comes up. */
    private fun connect(work: WorkInfo) {
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(work.id)
    }

    @Test
    fun theSaveGoesOnAfterTheScreenFollowingItIsGone() {
        val jobs = useWorkManager()

        // The screen follows it, then goes, as when the app is left or its session ends.
        val following = CoroutineScope(Dispatchers.IO + SupervisorJob())
        following.launch { jobs.save(api, request).collect {} }
        val work = enqueued("r1")
        following.cancel()
        assertTrue(ClipWorker.TAG in work.tags)

        connect(work)
        val done = runBlocking { withTimeout(TIMEOUT_MS) { manager.getWorkInfoByIdFlow(work.id).first { it?.state?.isFinished == true } } }

        assertEquals(WorkInfo.State.SUCCEEDED, done?.state)
        assertEquals(1, saved.size)
        assertEquals(listOf("Saved to Movies/Frigate"), posted())
    }

    @Test
    fun theScreenFollowsTheWorkToItsEndAndASecondTapJoinsIt() {
        val jobs = useWorkManager()

        val first = scope.async { jobs.save(api, request).toList() }
        val work = enqueued("r1")
        val second = scope.async { jobs.save(api, request).toList() }
        connect(work)
        val states = runBlocking { withTimeout(TIMEOUT_MS) { listOf(first.await(), second.await()) } }

        states.forEach { assertEquals(ClipState.Saved("content://media/external/video/media/7"), it.last()) }
        assertEquals(ClipState.Preparing, states[0].first())
        assertEquals("One export for both taps", 1, asked.count { it.startsWith("POST /api/export/") })
    }

    @Test
    fun cancelledWorkEndsWithNoState() {
        val jobs = useWorkManager()

        val following = scope.async { jobs.save(api, request).toList() }
        enqueued("r1")
        jobs.cancelAll()

        assertEquals(null, runBlocking { withTimeout(TIMEOUT_MS) { following.await() } }.last())
        assertTrue("Nothing asked of the server", asked.isEmpty())
    }

    private companion object {
        val TIMEOUT_MS = TimeUnit.SECONDS.toMillis(10)
    }
}
