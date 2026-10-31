package com.jtn.frigateviewer.tunnel

import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.TunnelSettings
import com.jtn.frigateviewer.ui.testSettingsStore
import com.wireguard.config.Config
import com.wireguard.crypto.KeyPair
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
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
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A tunnel file like UniFi's, with keys made for the test and documentation addresses. */
internal fun tunnelFile(
    extraInterface: String = "IncludedApplications = com.example.other",
    peer: String = "Endpoint = vpn.example.com:51820",
): String = """
    [Interface]
    PrivateKey = ${KeyPair().privateKey.toBase64()}
    Address = 192.168.2.2/32
    DNS = 192.168.2.1
    $extraInterface

    [Peer]
    PublicKey = ${KeyPair().publicKey.toBase64()}
    AllowedIPs = 0.0.0.0/0
    $peer
""".trimIndent()

/** Records what the tunnel was asked to do. */
internal class FakeBackend : TunnelBackend {
    var permitted = true
    var failure: String? = null
    val ups = CopyOnWriteArrayList<Config>()
    var downs = 0

    /** Whether the VPN server answers the tunnel's handshake. */
    var answers = true

    override fun hasPermission() = permitted

    override suspend fun up(config: Config) {
        failure?.let { throw TunnelException(it) }
        ups += config
    }

    override suspend fun down() {
        downs++
    }

    private var onStopped: () -> Unit = {}

    override fun watchStops(onStopped: () -> Unit) {
        this.onStopped = onStopped
    }

    /** The VPN goes down without the app asking, as when Android revokes it. */
    fun stopOutside() {
        downs++
        onStopped()
    }

    override suspend fun stats(): TunnelStats {
        val up = ups.size > downs
        return TunnelStats(
            sentBytes = if (up) 148 else 0,
            receivedBytes = if (up &&
                answers
            ) {
                92
            } else {
                0
            },
            lastHandshakeMs = if (up && answers) 1L else null,
        )
    }
}

internal class FakeRoute(var reach: Reach) : DirectRoute {
    var onChange: (() -> Unit)? = null

    override suspend fun check(baseUrl: String) = Probe(reach, "test route: $reach")

    override fun watch(onChange: () -> Unit): AutoCloseable {
        this.onChange = onChange
        return AutoCloseable { this.onChange = null }
    }
}

/** Waits in real time, since the store writes on its own threads. */
internal fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
    val end = System.currentTimeMillis() + timeoutMs
    while (!condition()) {
        if (System.currentTimeMillis() > end) fail("Timed out waiting")
        Thread.sleep(10)
    }
}

@RunWith(RobolectricTestRunner::class)
class RemoteAccessTest {
    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val store by lazy { testSettingsStore(File(temp.root, "server.preferences_pb"), scope) }
    private val backend = FakeBackend()
    private val route = FakeRoute(Reach.NOT_DIRECT)

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun remote(
        tunnel: TunnelSettings? = TunnelSettings(
            tunnelFile(),
            "home",
            enabled = true,
        ),
        idleMs: Long = 60_000,
        handshakeMs: Long = 15_000,
    ): RemoteAccess {
        runBlocking {
            store.save(ServerSettings(baseUrl = "http://192.168.1.20:5000/"))
            store.saveTunnel(tunnel)
        }
        return RemoteAccess(scope, store, backend, route, "com.jtn.frigateviewer", idleMs, handshakeMs).also { it.start() }
    }

    @Test
    fun theTunnelOnlyCarriesThisAppWhateverTheFileSays() {
        val config = appOnlyTunnel(tunnelFile(), "com.jtn.frigateviewer")
        assertEquals(setOf("com.jtn.frigateviewer"), config.`interface`.includedApplications)
        assertTrue(config.`interface`.excludedApplications.isEmpty())
        assertEquals("192.168.2.2/32", config.`interface`.addresses.single().toString())
        assertEquals("vpn.example.com:51820", config.peers.single().endpoint.get().toString())

        val excluding = appOnlyTunnel(tunnelFile(extraInterface = "ExcludedApplications = com.example.other"), "com.jtn.frigateviewer")
        assertTrue(excluding.`interface`.excludedApplications.isEmpty())
    }

    @Test
    fun unusableFilesSayWhy() {
        fun problem(text: String) = try {
            appOnlyTunnel(text, "com.jtn.frigateviewer")
            null
        } catch (e: TunnelConfigException) {
            e.message
        }
        assertEquals("This is not a WireGuard configuration file.", problem("<html>not it</html>"))
        assertEquals("The file's server has no Endpoint address.", problem(tunnelFile(peer = "")))
        assertEquals("The file has no server ([Peer]) to connect to.", problem(tunnelFile().substringBefore("[Peer]")))
    }

    @Test
    fun theFileIsSavedEncryptedAndNeverPrinted() {
        val text = tunnelFile()
        runBlocking { store.saveTunnel(TunnelSettings(text, "home", enabled = true)) }
        val key = text.lines().first { it.startsWith("PrivateKey") }.substringAfter("= ")
        val onDisk = File(temp.root, "server.preferences_pb").readBytes().decodeToString()
        assertFalse(key in onDisk)
        val saved = runBlocking { store.tunnel.first() }!!
        assertEquals(text, saved.config)
        assertFalse(key in saved.toString())

        runBlocking { store.saveTunnel(null) }
        assertNull(runBlocking { store.tunnel.first() })
    }

    @Test
    fun awayFromHomeTheTunnelComesUpOnceAndClosesBackHome() {
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        assertEquals(1, backend.ups.size)
        assertEquals(setOf("com.jtn.frigateviewer"), backend.ups.single().`interface`.includedApplications)
        assertEquals(1, remote.routeChanges)

        // Another network while still away: the running tunnel is kept.
        remote.check()
        await { remote.status == TunnelStatus.Connected }
        assertEquals(1, backend.ups.size)

        route.reach = Reach.DIRECT
        route.onChange!!()
        await { remote.status == TunnelStatus.Home }
        assertEquals(1, backend.downs)
        assertEquals(2, remote.routeChanges)
    }

    @Test
    fun aVpnStoppedOutsideTheAppIsNotShownConnected() {
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }

        // Stopped from outside (another VPN app, or the system's VPN settings): it is not
        // assumed still running, the lost route is reported, and it is brought back up.
        backend.stopOutside()
        await { backend.ups.size == 2 && remote.status == TunnelStatus.Connected }
        assertTrue(remote.log.entries.any { it.text == "The VPN was turned off outside the app" })
        assertTrue("The lost route is reported", remote.routeChanges >= 3)

        // Stopped again along with the app's VPN permission: it asks for the permission. A
        // check already under way may see the permission gone first; either way it ends here.
        backend.permitted = false
        backend.stopOutside()
        await { remote.status == TunnelStatus.NeedsPermission }
        assertEquals(2, backend.ups.size)
    }

    @Test
    fun aServerThatNeverAnswersIsReportedNotConnected() {
        backend.answers = false
        val remote = remote(handshakeMs = 200)
        remote.foreground()
        await { remote.status == TunnelStatus.Connecting }
        await { remote.status is TunnelStatus.Failed }
        assertTrue((remote.status as TunnelStatus.Failed).message.startsWith("The VPN server did not answer."))
        // Nothing moves to a tunnel that carries nothing.
        assertEquals(0, remote.routeChanges)

        // WireGuard keeps trying; once the server answers, it is used.
        backend.answers = true
        await { remote.status == TunnelStatus.Connected }
        assertEquals(1, remote.routeChanges)

        // The log tells the story: checked, started, gave up, then answered.
        val log = remote.log.entries.map { it.text }
        assertTrue(log.any { it == "Direct check: test route: NOT_DIRECT" })
        assertTrue(log.any { it.startsWith("Starting the tunnel to vpn.example.com:51820") })
        assertTrue(log.any { it.startsWith("Gave up waiting") })
        assertTrue(log.any { it.startsWith("VPN server answered") && "received 92 bytes" in it })
    }

    @Test
    fun theReportGivesKindsOfAddressAndNeverTheKey() {
        val text = tunnelFile(peer = "Endpoint = 100.72.9.14:51820")
        val remote = remote(tunnel = TunnelSettings(text, "home", enabled = true))
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        val report =
            tunnelReport(remote, "http://192.168.1.20:5000/", about = listOf("App test"), permitted = true, libraryLines = listOf())
        val key = text.lines().first { it.startsWith("PrivateKey") }.substringAfter("= ")
        assertFalse(key in report)
        assertFalse("100.72.9.14" in report)
        assertFalse("192.168.1.20" in report)
        assertTrue("VPN server 1: a carrier-grade NAT address (…14), not reachable from the internet, UDP port 51820" in report)
        assertTrue("Frigate server: http, port 5000, a private IPv4 address (…20)" in report)
        assertTrue("Routes through the tunnel (AllowedIPs): public …0/0" in report)
        assertTrue("Traffic: sent 148 bytes, received 92 bytes" in report)
    }

    @Test
    fun addressesAreMaskedToTheirKind() {
        assertEquals("peer at public …4:51820, via private …1", maskAddresses("peer at 203.0.113.4:51820, via 10.0.0.1"))
        assertEquals("a public IPv4 address (…4)", describeHost("203.0.113.4"))
        assertEquals("a hostname ending .com", describeHost("vpn.example.com"))
    }

    @Test
    fun theFileShowsWhichServerItDials() {
        assertEquals("vpn.example.com:51820", tunnelEndpoint(tunnelFile()))
        assertNull(tunnelEndpoint("not a tunnel"))
    }

    @Test
    fun atHomeTheTunnelStaysDown() {
        route.reach = Reach.DIRECT
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.Home }
        assertTrue(backend.ups.isEmpty())
        assertEquals(0, remote.routeChanges)
    }

    @Test
    fun turningItOffClosesTheTunnel() {
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        remote.setEnabled(false)
        await { remote.status == TunnelStatus.Off }
        assertEquals(1, backend.downs)
        assertFalse(runBlocking { store.tunnel.first() }!!.enabled)
    }

    @Test
    fun withoutAndroidsPermissionNothingStarts() {
        backend.permitted = false
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.NeedsPermission }
        assertTrue(backend.ups.isEmpty())

        backend.permitted = true
        remote.check()
        await { remote.status == TunnelStatus.Connected }
    }

    @Test
    fun aFailedStartIsShownAndTriedAgainLater() {
        backend.failure = "Could not look up the VPN server's address."
        val remote = remote()
        remote.foreground()
        await { remote.status is TunnelStatus.Failed }
        assertEquals("Could not look up the VPN server's address.", (remote.status as TunnelStatus.Failed).message)

        backend.failure = null
        route.onChange!!()
        await { remote.status == TunnelStatus.Connected }
    }

    @Test
    fun theTunnelClosesAfterTheAppHasBeenAwayAWhile() {
        val remote = remote(idleMs = 50)
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        remote.background()
        assertNull(route.onChange)
        await { backend.downs == 1 }

        remote.foreground()
        await { backend.ups.size == 2 }
    }

    @Test
    fun importingChecksTheFileBeforeSavingIt() {
        val remote = remote(tunnel = null)
        remote.foreground()
        await { remote.status == TunnelStatus.NotSetUp }
        assertEquals("This is not a WireGuard configuration file.", runBlocking { remote.import("notes.txt", "hello") })
        assertNull(runBlocking { store.tunnel.first() })

        assertNull(runBlocking { remote.import("home.conf", tunnelFile()) })
        await { remote.status == TunnelStatus.Connected }
        assertEquals("home", remote.tunnel?.name)
    }
}
