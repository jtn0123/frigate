package com.jtn.frigateviewer

import android.util.Log
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.ui.json
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
class AppContainerTest {
    @get:Rule val folder = TemporaryFolder()

    @get:Rule val serverRule = MockWebServerRule()

    private val scope = CoroutineScope(Dispatchers.IO + Job())

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun aSessionResumesWithATokenOrWithNoLogin() {
        assertFalse(ServerSettings().canResume)
        assertTrue(ServerSettings(baseUrl = "http://nvr:5000").canResume)
        assertTrue(ServerSettings(baseUrl = "https://nvr:8971", username = "admin", token = "jwt").canResume)
        assertFalse(
            "Signed out: the login is known but its token is gone",
            ServerSettings(baseUrl = "https://nvr:8971", username = "admin").canResume,
        )
    }

    @Test
    fun theResumedSessionSavesARenewedTokenWithoutUndoingOtherChanges() {
        val container = installTestContainer(folder.root, scope)
        val store = container.settingsStore
        val started = ServerSettings(baseUrl = serverRule.server.url("/").toString(), username = "admin", token = "old", theme = "a")
        runBlocking { store.save(started) }
        assertNull(container.resumeSession(started.copy(token = ""), scope))
        val session = requireNotNull(container.resumeSession(started, scope))
        // Another part of the app changes a setting while the session runs.
        runBlocking { store.update { it.copy(theme = "b") } }
        serverRule.server.enqueue(json("""{"cameras": {}}""").newBuilder().addHeader("Set-Cookie", "frigate_token=new; Path=/").build())

        runBlocking { session.api.config() }

        val saved = runBlocking { withTimeout(30_000) { store.settings.filter { it.token == "new" }.first() } }
        assertEquals("b", saved.theme)
    }

    @Test
    fun onlyDebugBuildsEchoTheTunnelLogToLogcat() {
        FrigateApp.tunnelLog(debug = false).add("Direct check: answered over Wi-Fi")
        assertTrue(ShadowLog.getLogsForTag("FrigateTunnel").isEmpty())

        FrigateApp.tunnelLog(debug = true).add("Direct check: answered over Wi-Fi")
        assertEquals(Log.INFO, ShadowLog.getLogsForTag("FrigateTunnel").single().type)
    }
}
