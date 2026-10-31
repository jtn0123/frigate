package com.jtn.frigateviewer

import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.jtn.frigateviewer.ui.json
import com.jtn.frigateviewer.widget.CameraWidget
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** The app as launched from the home screen widget: a tapped camera opens straight to that camera. */
@RunWith(RobolectricTestRunner::class)
class MainActivityTest {
    @get:Rule val compose = createEmptyComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    private val context: Context = ApplicationProvider.getApplicationContext()

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
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/config" -> json("""{"cameras": {"driveway": {"friendly_name": "Driveway"}}}""")
                "/api/review" -> json("[]")
                else -> json("{}")
            }
        }
        saveServer(serverRule.server.url("/").toString())
        val intent = Intent(context, MainActivity::class.java).putExtra(CameraWidget.EXTRA_CAMERA, "driveway")

        ActivityScenario.launch<MainActivity>(intent).use {
            // The camera's own screen, over the camera list: its activity and a way back.
            awaitText("Activity · last 24 hours")
            compose.onNodeWithContentDescription("Back").assertExists()
        }
    }

    /** Waits for [text], running the main looper, where the view model's work resumes after each request. */
    private fun awaitText(text: String, timeoutMs: Long = 10_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (compose.onAllNodes(hasText(text)).fetchSemanticsNodes().isEmpty()) {
            check(System.currentTimeMillis() < deadline) { "Timed out waiting for $text" }
            Thread.sleep(10)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
        }
    }
}
