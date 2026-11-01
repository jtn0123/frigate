package com.jtn.frigateviewer.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowVpnService

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

    private val backend = FakeBackend()

    private fun show(
        tunnel: TunnelSettings?,
        reach: Reach = Reach.NOT_DIRECT,
        answers: Boolean = true,
        otherVpn: Boolean = false,
    ): RemoteAccess {
        runBlocking {
            store.save(ServerSettings(baseUrl = "http://192.168.1.20:5000/"))
            store.saveTunnel(tunnel)
        }
        val remote = RemoteAccess(
            main,
            store,
            backend.also {
                it.answers = answers
            },
            FakeRoute(reach, otherVpn),
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

    @Test
    fun theChecksIncludeAClientTheServerNoLongerKnows() {
        val checks = noAnswerChecks("203.0.113.4" to 51820).joinToString("\n")
        assertTrue(checks, "not deleted or re-created since" in checks)
        assertTrue(checks, "The VPN server is on" in checks)
    }

    @Test
    fun eachRowSaysWhatATapDoes() {
        show(tunnel = null)
        assertEquals("Choose the WireGuard file", clickLabel("Set up WireGuard"))
        assertEquals("Show Tunnel log", clickLabel("Tunnel log"))
    }

    @Test
    fun theTunnelFileRowSaysItCanBeReplacedOrRemoved() {
        show(TunnelSettings(tunnelFile(), "home", enabled = true))
        compose.awaitText("Tunnel file")
        assertEquals("Replace or remove the tunnel file", clickLabel("Tunnel file"))
    }

    @Test
    fun aFileProblemIsAnnounced() {
        compose.setContent { ImportProblem("This is not a WireGuard configuration file.") }
        val node = compose.onNodeWithText("This is not a WireGuard configuration file.").fetchSemanticsNode()
        assertEquals(LiveRegionMode.Polite, node.config[SemanticsProperties.LiveRegion])
    }

    @Test
    fun aFileFarTooBigSaysSoRatherThanUnreadable() {
        val big = File(temp.root, "photo.jpg").apply { writeBytes(ByteArray(70 * 1024)) }
        val tooBig = read(big) as? PickedFile.Unreadable
        assertTrue("$tooBig", tooBig?.problem.orEmpty().startsWith("That file is too big to be a WireGuard file"))

        val small = File(temp.root, "home.conf").apply { writeText(tunnelFile()) }
        val usable = read(small) as? PickedFile.Read
        assertTrue("$usable", usable?.text.orEmpty().startsWith("[Interface]"))
    }

    @Test
    fun aUtf16FileFromNotepadIsRead() {
        val text = tunnelFile()
        val utf16 = byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + text.toByteArray(Charsets.UTF_16LE)
        assertEquals(text, decodeTunnelFile(utf16))
        val bigEndian = byteArrayOf(0xFE.toByte(), 0xFF.toByte()) + text.toByteArray(Charsets.UTF_16BE)
        assertEquals(text, decodeTunnelFile(bigEndian))
        assertEquals(text, decodeTunnelFile(text.toByteArray()))
    }

    @Test
    fun throughAnotherVpnItSaysTheTunnelIsNotNeeded() {
        show(TunnelSettings(tunnelFile(), "home", enabled = true), reach = Reach.DIRECT, otherVpn = true)
        compose.awaitText("The server answers through another VPN, so the tunnel is off.")
        compose.onNodeWithText("Use the app's tunnel instead").assertDoesNotExist()
    }

    @Test
    fun anotherVpnInTheWayCanBeSwappedForTheTunnel() {
        show(TunnelSettings(tunnelFile(), "home", enabled = true), otherVpn = true)
        compose.awaitText("Another VPN is on but does not reach the server.", substring = true)
        assertTrue(backend.ups.isEmpty())

        compose.onNodeWithText("Use the app's tunnel instead").performClick()

        compose.awaitText("Away from home, connected through the tunnel.")
        assertEquals(1, backend.ups.size)
    }

    @Test
    fun aTunnelStoppedOutsideTheAppCanBeStartedAgain() {
        show(TunnelSettings(tunnelFile(), "home", enabled = true))
        compose.awaitText("Away from home, connected through the tunnel.")
        compose.runOnIdle { backend.stopOutside() }
        compose.awaitText("The tunnel was turned off outside the app, so it stays off for now.")

        compose.onNodeWithText("Start the tunnel").performClick()

        compose.awaitText("Away from home, connected through the tunnel.")
        assertEquals(2, backend.ups.size)
    }

    @Test
    fun turningItOnWithAnotherVpnOnDoesNotAskAndroid() {
        // Asking Android, even with the permission given, would turn the other VPN off.
        ShadowVpnService.setPrepareResult(Intent("android.net.vpn.PREPARE"))
        val app = shadowOf(ApplicationProvider.getApplicationContext<Application>())
        show(TunnelSettings(tunnelFile(), "home", enabled = false), reach = Reach.DIRECT, otherVpn = true)
        compose.awaitText("Off. The app only connects directly.")

        compose.onNodeWithText("Use away from home").performClick()

        compose.awaitText("The server answers through another VPN, so the tunnel is off.")
        assertNull(app.nextStartedActivity)
    }

    @Test
    fun turningItOnWithoutAnotherVpnAsksAndroidOnce() {
        ShadowVpnService.setPrepareResult(Intent("android.net.vpn.PREPARE"))
        val app = shadowOf(ApplicationProvider.getApplicationContext<Application>())
        show(TunnelSettings(tunnelFile(), "home", enabled = false), reach = Reach.DIRECT)
        compose.awaitText("Off. The app only connects directly.")

        compose.onNodeWithText("Use away from home").performClick()

        compose.awaitMain { app.peekNextStartedActivity() != null }
        assertEquals("android.net.vpn.PREPARE", app.nextStartedActivity.action)
    }

    private fun read(file: File): PickedFile = runBlocking {
        readTunnelFile(ApplicationProvider.getApplicationContext(), Uri.fromFile(file))
    }

    private fun clickLabel(text: String): String? =
        compose.onNodeWithText(text).fetchSemanticsNode().config[SemanticsActions.OnClick].label
}
