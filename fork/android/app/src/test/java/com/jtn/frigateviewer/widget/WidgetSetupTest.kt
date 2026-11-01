package com.jtn.frigateviewer.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.installTestContainer
import com.jtn.frigateviewer.ui.json
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** The widget's camera picker, which any app can open: only for this app's widgets, and behind the app lock. */
@RunWith(RobolectricTestRunner::class)
class WidgetSetupTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    private var pendingUnlock: ((Boolean, String?) -> Unit)? = null
    private var unlockAsked = 0

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun setUp(settings: (ServerSettings) -> ServerSettings = { it }) = installTestContainer(folder.root, scope) { onResult ->
        unlockAsked++
        pendingUnlock = onResult
    }.also { container ->
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/config" -> json("""{"cameras": {"yard": {"friendly_name": "Yard"}}}""")
                    .newBuilder().addHeader("Set-Cookie", "frigate_token=renewed; Path=/").build()
                else -> json("{}")
            }
        }
        val saved = settings(ServerSettings(baseUrl = serverRule.server.url("/").toString(), username = "admin", token = "jwt"))
        runBlocking { container.settingsStore.save(saved) }
    }

    private fun place(id: Int, provider: ComponentName = ComponentName(context, CameraWidget::class.java)) {
        val info = AppWidgetProviderInfo().apply { this.provider = provider }
        shadowOf(AppWidgetManager.getInstance(context)).addBoundWidget(id, info)
    }

    private fun intent(id: Int) = Intent(context, WidgetSetupActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)

    @Test
    fun anotherAppsWidgetOrAMadeUpIdIsRefused() {
        setUp()
        place(5, ComponentName("com.example.other", "com.example.other.Widget"))

        listOf(5, 6, AppWidgetManager.INVALID_APPWIDGET_ID).forEach { id ->
            ActivityScenario.launchActivityForResult<WidgetSetupActivity>(intent(id)).use {
                assertEquals(Activity.RESULT_CANCELED, it.result.resultCode)
            }
        }
        assertEquals(0, serverRule.server.requestCount)
    }

    @Test
    fun theCamerasAreListedAndARenewedTokenIsSaved() {
        val container = setUp()
        place(7)

        ActivityScenario.launch<WidgetSetupActivity>(intent(7)).use {
            awaitText("Yard")
            assertEquals(0, unlockAsked)
            val saved = runBlocking { container.settingsStore.settings.first { it.token == "renewed" } }
            assertEquals("admin", saved.username)
        }
    }

    @Test
    fun withTheAppLockOnNothingIsLoadedUntilUnlocked() {
        setUp { it.copy(appLock = true) }
        place(8)

        ActivityScenario.launch<WidgetSetupActivity>(intent(8)).use { scenario ->
            awaitText("Frigate is locked")
            assertEquals(1, unlockAsked)
            assertEquals(0, serverRule.server.requestCount)

            scenario.onActivity { requireNotNull(pendingUnlock)(false, "Too many attempts") }
            awaitText("Too many attempts")
            assertEquals(0, serverRule.server.requestCount)

            scenario.onActivity { requireNotNull(pendingUnlock)(true, null) }
            awaitText("Yard")
        }
    }

    /** Waits for [text], running the main looper, where the activity's work resumes after each request. */
    private fun awaitText(text: String, timeoutMs: Long = 10_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (compose.onAllNodes(hasText(text)).fetchSemanticsNodes().isEmpty()) {
            check(System.currentTimeMillis() < deadline) { "Timed out waiting for $text" }
            Thread.sleep(10)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
        }
    }
}
