package com.jtn.frigateviewer.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.TunnelSettings
import com.jtn.frigateviewer.tunnel.FakeBackend
import com.jtn.frigateviewer.tunnel.FakeRoute
import com.jtn.frigateviewer.tunnel.Reach
import com.jtn.frigateviewer.tunnel.RemoteAccess
import com.jtn.frigateviewer.tunnel.tunnelFile
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The Remote access rows in Settings, over a fake tunnel. */
@RunWith(RobolectricTestRunner::class)
class RemoteAccessSettingsTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    /** The tunnel's state changes on the main thread, as in the app, so the screen follows it. */
    private val main = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val store by lazy { testSettingsStore(File(temp.root, "server.preferences_pb"), scope) }

    @After
    fun tearDown() {
        main.cancel()
        scope.cancel()
    }

    private fun show(tunnel: TunnelSettings?, reach: Reach = Reach.NOT_DIRECT, answers: Boolean = true): RemoteAccess {
        runBlocking {
            store.save(ServerSettings(baseUrl = "http://192.168.1.20:5000/"))
            store.saveTunnel(tunnel)
        }
        val remote = RemoteAccess(
            main,
            store,
            FakeBackend().also {
                it.answers = answers
            },
            FakeRoute(reach),
            "com.jtn.frigateviewer",
            handshakeMs = 100,
        ).also { it.start() }
        remote.foreground()
        compose.setContent { Column { RemoteAccessSettings(remote, onShowLog = {}) } }
        return remote
    }

    @Test
    fun withoutATunnelItOffersToImportOne() {
        show(tunnel = null)
        compose.onNodeWithText("Set up WireGuard").assertExists()
        compose.onNodeWithText("Use away from home").assertDoesNotExist()
    }

    @Test
    fun awayItSaysTheTunnelIsUsedAndCanBeTurnedOff() {
        show(TunnelSettings(tunnelFile(), "home", enabled = true))
        compose.awaitText("Away from home, connected through the tunnel.")
        compose.onNodeWithText("home · Server vpn.example.com:51820").assertExists()
        compose.onNodeWithText("Use away from home").assertIsOn().performClick()

        compose.awaitText("Off. The app only connects directly.")
        compose.onNodeWithText("Use away from home").assertIsOff()
        assertFalse(runBlocking { store.tunnel.first() }!!.enabled)
    }

    @Test
    fun atHomeItSaysTheTunnelIsNotNeeded() {
        show(TunnelSettings(tunnelFile(), "home", enabled = true), reach = Reach.DIRECT)
        compose.awaitText("The server answers directly, so the tunnel is off.")
    }

    @Test
    fun aSilentServerGetsThingsToCheck() {
        show(TunnelSettings(tunnelFile(), "home", enabled = true), answers = false)
        compose.awaitText("Things to check:")
        compose.onNodeWithText("UDP port 51820", substring = true).assertExists()
    }

    @Test
    fun aServerAddressTheInternetCannotReachIsCalledOut() {
        val checks = noAnswerChecks("100.72.9.14" to 51820)
        assertTrue(checks.any { "carrier-grade NAT" in it && "The internet cannot reach it" in it })
        assertFalse(noAnswerChecks("203.0.113.4" to 51820).any { "cannot reach" in it })
    }

    @Test
    fun theFileCanBeRemoved() {
        show(TunnelSettings(tunnelFile(), "home", enabled = true))
        // The saved tunnel loads after the first frame.
        compose.awaitText("Away from home, connected through the tunnel.")
        compose.onNodeWithText("Tunnel file").performClick()
        compose.onNodeWithText("Remove").performClick()
        compose.awaitText("Set up WireGuard")
        assertNull(runBlocking { store.tunnel.first() })
    }
}
