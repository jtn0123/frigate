package com.jtn.frigateviewer.ui

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.jtn.frigateviewer.data.isNewerRelease
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class HealthScreenTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val stats = javaClass.classLoader!!.getResource("stats.json")!!.readText()

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val config = """{"cameras": {"driveway": {"friendly_name": "Driveway"}, "garage": {}}}"""

    @Test
    fun settingsOpensHealthWithTheServersFigures() {
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            when (request.url.encodedPath) {
                "/api/stats" -> json(stats)
                "/api/config" -> json(config)
                else -> null
            }
        }
        compose.runOnIdle { vm.nav.tab = Tab.SETTINGS }

        compose.onNodeWithText("Server health").performScrollTo().performClick()
        compose.awaitText("3d 4h")

        compose.runOnIdle { assertEquals(Overlay.Health, vm.nav.overlays.last()) }
        compose.onNodeWithText("24%").assertExists()
        compose.onNodeWithText("Frigate 0.17.0-abc123 · 0.17.1 available").assertExists()
        compose.onNodeWithText("8.4 ms per frame").assertExists()
        compose.onNodeWithText("Driveway").performScrollTo()
        compose.onNodeWithText("5.1 fps in · 5 processed").assertExists()
        compose.onNodeWithText("No frames coming in").performScrollTo().assertExists()
        compose.onNodeWithText("924 GB of 1 TB").performScrollTo().assertExists()
    }

    @Test
    fun aFailedLoadOffersRetry() {
        val fail = AtomicBoolean(true)
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            if (request.url.encodedPath == "/api/stats") (if (fail.get()) json("{}", code = 500) else json(stats)) else null
        }
        compose.runOnIdle { vm.nav.push(Overlay.Health) }
        compose.awaitText("Couldn't load this")

        fail.set(false)
        compose.onNodeWithText("Retry").performScrollTo().performClick()
        compose.awaitText("3d 4h")
        assertTrue(serverRule.server.requestCount > 0)
    }

    @Test
    fun uptimeAndSizesReadNaturally() {
        assertEquals("8m", formatUptime(500).english())
        assertEquals("5h 12m", formatUptime(5 * 3600 + 12 * 60).english())
        assertEquals("512 MB", size(512.0).english())
        assertEquals("3.5 GB", size(3.5 * 1024).english())
    }

    @Test
    fun onlyANewerReleaseCountsAsAnUpdate() {
        assertTrue(isNewerRelease("0.17.1", "0.17.0-abc123"))
        assertTrue(isNewerRelease("0.18.0", "0.17.9"))
        assertFalse("A build of the same release", isNewerRelease("0.18.0-20261017.51", "0.18.0-621de23a2"))
        assertFalse(isNewerRelease("0.17.0", "0.18.0"))
    }
}
