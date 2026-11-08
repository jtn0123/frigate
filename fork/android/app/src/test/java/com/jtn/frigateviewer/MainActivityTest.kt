package com.jtn.frigateviewer

import android.app.Activity
import android.app.Application
import android.app.PictureInPictureParams
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.core.view.WindowCompat
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.ui.json
import com.jtn.frigateviewer.widget.CameraWidget
import com.jtn.frigateviewer.widget.WidgetChoices
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** The app as launched from the home screen widget: a tapped camera opens straight to that camera. */
@RunWith(RobolectricTestRunner::class)
class MainActivityTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()

    private val scope = CoroutineScope(Dispatchers.IO + Job())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val routes = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
            "/api/config" -> json("""{"cameras": {"driveway": {"friendly_name": "Driveway"}}}""")
            "/api/review" -> json("[]")
            else -> json("{}")
        }
    }

    /**
     * Signs the app in to the fake server through a test container, whose settings are this
     * test's own; the app's own settings file is opened once per process, so it keeps the first test's.
     */
    private fun useServer(appLock: Boolean = false, unlock: Activity.((Boolean, String?) -> Unit) -> Unit = {}) {
        val container = installTestContainer(temp.root, scope, unlock)
        serverRule.server.dispatcher = routes
        runBlocking { container.settingsStore.save(ServerSettings(baseUrl = serverRule.server.url("/").toString(), appLock = appLock)) }
    }

    /** What the widget's PendingIntent opens: its camera, and the token only it is given. */
    private fun widgetIntent() = Intent(context, MainActivity::class.java)
        .putExtra(CameraWidget.EXTRA_CAMERA, "driveway")
        .putExtra(WidgetLaunch.EXTRA_TOKEN, WidgetLaunch.token(context))

    /**
     * Saves a server without a login in the app's own settings file, the way the app
     * would. With no token nothing is encrypted, so the Android Keystore, which tests
     * do not have, is never needed.
     */
    private fun saveServer(url: String) {
        val job = Job()
        val store = PreferenceDataStoreFactory.create(scope = CoroutineScope(Dispatchers.IO + job)) {
            context.preferencesDataStoreFile("server")
        }
        runBlocking {
            store.edit { it[stringPreferencesKey("base_url")] = url }
            // One file may only have one store open, and the app opens its own.
            job.cancel()
            job.join()
        }
    }

    @Test
    fun theWidgetsCameraOpensOnLaunch() {
        serverRule.server.dispatcher = routes
        saveServer(serverRule.server.url("/").toString())

        ActivityScenario.launch<MainActivity>(widgetIntent()).use {
            // The camera's own screen, over the camera list: its activity and a way back.
            awaitText("Activity · last 24 hours")
            compose.onNodeWithContentDescription("Back").assertExists()
        }
    }

    @Test
    fun anotherAppNamingACameraOnlyOpensTheApp() {
        useServer()
        val forged = Intent(context, MainActivity::class.java)
            .putExtra(CameraWidget.EXTRA_CAMERA, "driveway")
            .putExtra(WidgetLaunch.EXTRA_TOKEN, "guessed")

        ActivityScenario.launch<MainActivity>(forged).use {
            // The camera list, not the camera's own screen.
            awaitLooper(what = "the camera list") {
                compose.onAllNodes(hasContentDescription("Driveway", substring = true)).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("Activity · last 24 hours").assertDoesNotExist()
            compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        }
    }

    @Test
    fun theWidgetsCameraWaitsBeneathTheLockAndIsThereOnUnlock() {
        var answer: ((Boolean, String?) -> Unit)? = null
        useServer(appLock = true) { answer = it }

        ActivityScenario.launch<MainActivity>(widgetIntent()).use {
            awaitText("Frigate is locked")
            awaitLooper { answer != null }
            compose.onNodeWithText("Activity · last 24 hours").assertDoesNotExist()

            answer?.invoke(true, null)

            awaitText("Activity · last 24 hours")
            compose.onNodeWithText("Frigate is locked").assertDoesNotExist()
        }
    }

    @Test
    fun theStatusBarsIconsStayLightOnTheDarkThemesInLightMode() {
        useServer()

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                assertFalse(bars.isAppearanceLightStatusBars)
                assertFalse(bars.isAppearanceLightNavigationBars)
            }
        }
    }

    /** Widget [id] on the home screen, last updated at [updatedAt]. */
    private fun placeWidget(id: Int, updatedAt: Long) {
        val info = AppWidgetProviderInfo().apply { provider = ComponentName(context, CameraWidget::class.java) }
        shadowOf(AppWidgetManager.getInstance(context)).addBoundWidget(id, info)
        WidgetChoices(context).markUpdated(id, updatedAt)
    }

    /** The widgets asked to update since the last call, by ID. */
    private fun widgetUpdates(): List<Int> {
        val app = shadowOf(context as Application)
        val sent = app.broadcastIntents.filter { it.action == AppWidgetManager.ACTION_APPWIDGET_UPDATE }
        app.clearBroadcastIntents()
        return sent.flatMap { it.getIntArrayExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS)?.toList().orEmpty() }
    }

    @Test
    fun leavingTheAppRefreshesOnlyTheWidgetsNotUpdatedAMomentAgo() {
        useServer()
        val now = System.currentTimeMillis()
        placeWidget(1, updatedAt = now)
        placeWidget(2, updatedAt = now - CameraWidget.FRESH_MS)

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            widgetUpdates()
            scenario.moveToState(Lifecycle.State.CREATED)
            assertEquals(listOf(2), widgetUpdates())

            // Back, and away again once that one has shown a fresh picture: nothing is asked.
            scenario.moveToState(Lifecycle.State.RESUMED)
            WidgetChoices(context).markUpdated(2)
            scenario.moveToState(Lifecycle.State.CREATED)
            assertEquals(emptyList<Int>(), widgetUpdates())
        }
    }

    @Test
    fun aVideoFloatingInItsWindowPutsTheRefreshOffUntilTheWindowCloses() {
        useServer()
        placeWidget(3, updatedAt = 0)

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            widgetUpdates()
            scenario.onActivity { it.enterPictureInPictureMode(PictureInPictureParams.Builder().build()) }
            scenario.moveToState(Lifecycle.State.CREATED)
            assertEquals("Still in use", emptyList<Int>(), widgetUpdates())

            scenario.onActivity { it.onPictureInPictureModeChanged(false, it.resources.configuration) }
            assertEquals(listOf(3), widgetUpdates())
        }
    }

    /** Waits for [text], running the main looper, where the view model's work resumes after each request. */
    private fun awaitText(text: String, timeoutMs: Long = 10_000) =
        awaitLooper(timeoutMs, text) { compose.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty() }

    private fun awaitLooper(timeoutMs: Long = 10_000, what: String = "the condition", condition: () -> Boolean) =
        waitOnMain(what, timeoutMs, condition = condition)
}
