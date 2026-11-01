package com.jtn.frigateviewer.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.buildHttpClient
import com.jtn.frigateviewer.installTestContainer
import com.jtn.frigateviewer.ui.json
import java.util.Collections
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** One update for every placed widget: within one time limit, one alert count, the frames side by side. */
@RunWith(RobolectricTestRunner::class)
class WidgetUpdateTest {
    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private val paths: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val cameras = listOf(WidgetChoice("front", "Front"), WidgetChoice("yard", "Yard"), WidgetChoice("side", "Side"))

    @After
    fun tearDown() {
        scope.cancel()
    }

    /** A server whose frames each take [frameDelayMs], and everything else [otherDelayMs]. */
    private fun serve(frameDelayMs: Long = 0, otherDelayMs: Long = 0) {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                paths += request.url.encodedPath + "?" + request.url.encodedQuery
                return when {
                    request.url.encodedPath.endsWith("/latest.jpg") ->
                        MockResponse.Builder().body(
                            Buffer().write(byteArrayOf(1, 2, 3)),
                        ).headersDelay(frameDelayMs, TimeUnit.MILLISECONDS).build()
                    request.url.encodedPath == "/api/review" ->
                        json(ALERT).newBuilder().headersDelay(otherDelayMs, TimeUnit.MILLISECONDS).build()
                    else -> json("{}")
                }
            }
        }
    }

    private fun api() = FrigateApi(buildHttpClient(null, null), serverRule.server.url("/").toString())

    @Test
    fun theAlertCountIsFetchedOnceForAllWidgetsAndOnlyAsFarAsTheBadgeGoes() {
        serve()
        val contents = runBlocking { api().widgetContents(cameras, ServerSettings()) }

        assertEquals(listOf(1, 1, 1), contents.map { (it as WidgetContent.Ready).toReview })
        val reviews = paths.filter { it.startsWith("/api/review?") }
        assertEquals(1, reviews.size)
        assertTrue(reviews.single(), "limit=100" in reviews.single() && "reviewed=0" in reviews.single())
        assertEquals(3, paths.count { "latest.jpg" in it })
    }

    @Test
    fun theFramesAreFetchedSideBySide() {
        // One after another, three frames would take 3 s, past the limit.
        serve(frameDelayMs = 1_000)
        val contents = runBlocking { api().widgetContents(cameras, ServerSettings(), timeoutMs = 2_500) }

        assertTrue(contents.toString(), contents.all { it is WidgetContent.Ready })
    }

    @Test
    fun theWholeUpdateIsBoundedNotEachWidget() {
        // Waiting for the server would take 5 s.
        serve(frameDelayMs = 5_000, otherDelayMs = 5_000)
        val started = System.nanoTime()
        val contents = runBlocking { api().widgetContents(cameras, ServerSettings(), timeoutMs = 400) }
        val tookMs = (System.nanoTime() - started) / 1_000_000

        assertEquals(List(3) { WidgetContent.Failed("Could not connect to the server") }, contents)
        assertTrue("Took $tookMs ms", tookMs < 3_000)
    }

    @Test
    fun withNoCameraChosenNothingIsAsked() {
        serve()
        assertTrue(runBlocking { api().widgetContents(emptyList(), ServerSettings()) }.isEmpty())
        assertTrue(paths.isEmpty())
    }

    private fun placeWidgets(vararg ids: Int) {
        val info = AppWidgetProviderInfo().apply { provider = ComponentName(context, CameraWidget::class.java) }
        ids.forEach { shadowOf(AppWidgetManager.getInstance(context)).addBoundWidget(it, info) }
    }

    @Test
    fun anUpdateLoadsEveryChosenWidgetTogether() {
        serve()
        val container = installTestContainer(folder.root, scope)
        runBlocking { container.settingsStore.save(ServerSettings(baseUrl = serverRule.server.url("/").toString())) }
        placeWidgets(1, 2, 3)
        val choices = WidgetChoices(context)
        choices[1] = cameras[0]
        choices[2] = cameras[1]

        runBlocking { CameraWidget.update(context, intArrayOf(1, 2, 3)) }

        assertEquals(1, paths.count { it.startsWith("/api/review?") })
        assertEquals(2, paths.count { "latest.jpg" in it })
        assertTrue(choices.shownSinceBoot(1) && choices.shownSinceBoot(2) && choices.shownSinceBoot(3))
    }

    @Test
    fun signedOutTheWidgetsAskNothingOfTheServer() {
        serve()
        installTestContainer(folder.root, scope)
        placeWidgets(4)
        WidgetChoices(context)[4] = cameras[0]

        runBlocking { CameraWidget.update(context, intArrayOf(4)) }

        assertTrue(paths.isEmpty())
        assertTrue(WidgetChoices(context).shownSinceBoot(4))
    }

    private companion object {
        const val ALERT = """[{"id": "a", "camera": "front", "start_time": 1, "severity": "alert", """ +
            """"has_been_reviewed": false, "thumb_path": "t.webp"}]"""
    }
}
