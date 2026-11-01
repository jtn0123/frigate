package com.jtn.frigateviewer.ui

import androidx.compose.ui.test.junit4.v2.createComposeRule
import com.jtn.frigateviewer.data.Remote
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Settings shows Frigate's version, or why it could not be read. */
@RunWith(RobolectricTestRunner::class)
class ServerVersionTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun theVersionIsShown() {
        val vm = compose.showApp(serverRule.server, temp.root, scope)
        compose.awaitMain { vm.serverVersion is Remote.Ready }
        compose.runOnIdle { vm.nav.tab = Tab.SETTINGS }
        compose.awaitText("0.17.0")
    }

    @Test
    fun aFailureSaysWhy() {
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            if (request.url.encodedPath == "/api/version") MockResponse.Builder().code(500).body("down").build() else null
        }
        compose.awaitMain { vm.serverVersion is Remote.Failed }
        compose.runOnIdle { vm.nav.tab = Tab.SETTINGS }
        compose.awaitText("Unknown: ", substring = true)
    }

    @Test
    fun theTextForEachState() {
        assertEquals("Checking…", versionText(Remote.Loading))
        assertEquals("0.17.0", versionText(Remote.Ready("0.17.0")))
        assertEquals("Unknown: Server not found", versionText(Remote.Failed("Server not found")))
    }
}
