package com.jtn.frigateviewer.tunnel

import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.TunnelSettings
import com.jtn.frigateviewer.ui.testSettingsStore
import com.wireguard.config.Config
import com.wireguard.crypto.KeyPair
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
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

    /** How often Android was asked for the VPN permission, which on a phone turns another app's VPN off. */
    val permissionAsks = AtomicInteger()
    var failure: String? = null

    /** How long starting takes, without giving way to cancellation, as WireGuard's library does. */
    var upMs = 0L

    /** What the failure was caused by, as the library would say it. */
    var cause: Throwable? = null
    val ups = CopyOnWriteArrayList<Config>()
    var downs = 0

    /** Whether the VPN server answers the tunnel's handshake. */
    var answers = true

    override fun hasPermission(): Boolean {
        permissionAsks.incrementAndGet()
        return permitted
    }

    override suspend fun up(config: Config) {
        failure?.let { throw TunnelException(it, cause) }
        withContext(Dispatchers.IO) {
            Thread.sleep(upMs)
            ups += config
        }
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

internal class FakeRoute(var reach: Reach, var otherVpn: Boolean = false) : DirectRoute {
    var onChange: (() -> Unit)? = null

    /** Whether the app's tunnel was up for each check. */
    val checkedWithTunnel = CopyOnWriteArrayList<Boolean>()

    override suspend fun check(baseUrl: String, ownTunnelUp: Boolean): Probe {
        checkedWithTunnel += ownTunnelUp
        return Probe(reach, "test route: $reach${if (otherVpn) " through another VPN" else ""}", otherVpn)
    }

    override fun otherVpnOn(ownTunnelUp: Boolean) = otherVpn

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
        reportMs: Long = 5_000,
    ): RemoteAccess {
        runBlocking {
            store.save(ServerSettings(baseUrl = "http://192.168.1.20:5000/"))
            store.saveTunnel(tunnel)
        }
        return RemoteAccess(scope, store, backend, route, "com.jtn.frigateviewer", idleMs, handshakeMs, reportMs).also { it.start() }
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
    fun aVpnStoppedOutsideTheAppIsNotShownConnectedNorStartedAgainUnasked() {
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }

        // Stopped from outside (another VPN app, or the system's VPN settings): it is not
        // assumed still running, the lost route is reported, and it is not started again
        // over the user's choice.
        backend.stopOutside()
        await { remote.status == TunnelStatus.StoppedOutside }
        assertEquals(1, backend.ups.size)
        assertTrue(remote.log.entries.any { it.text == "The VPN was turned off outside the app" })
        assertEquals("The lost route is reported", 2, remote.routeChanges)

        // Started again from Settings.
        remote.startTunnel()
        await { backend.ups.size == 2 && remote.status == TunnelStatus.Connected }

        // Stopped again along with the app's VPN permission: starting it asks for the permission.
        backend.permitted = false
        backend.stopOutside()
        await { remote.status == TunnelStatus.StoppedOutside }
        remote.startTunnel()
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
        assertTrue(log.any { it == "Starting the tunnel to a hostname ending .com, UDP port 51820" })
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
            tunnelReport(remote, "http://192.168.1.20:5000/", about = listOf("App test"), libraryLines = listOf())
        val key = text.lines().first { it.startsWith("PrivateKey") }.substringAfter("= ")
        assertFalse(key in report)
        assertFalse("100.72.9.14" in report)
        assertFalse("192.168.1.20" in report)
        assertTrue("VPN server 1: a carrier-grade NAT address (…14), not reachable from the internet, UDP port 51820" in report)
        assertTrue("Frigate server: http, port 5000, a private IPv4 address (…20)" in report)
        assertTrue("Routes through the tunnel (AllowedIPs): all IPv4 traffic" in report)
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

    @Test
    fun theNoAnswerMessageNamesAClientTheServerDoesNotKnow() {
        // The server drops an unknown key's handshakes silently, which looks the same as a wrong address.
        assertTrue("not deleted, re-created or left unsaved" in NO_ANSWER)
        assertTrue("the VPN server is on" in NO_ANSWER)
        assertTrue("does not block UDP" in NO_ANSWER)
        assertTrue("turn off \"Use away from home\" to stop" in NO_ANSWER)
    }

    @Test
    fun givingUpIsOneLineWithTheFigures() {
        backend.answers = false
        val remote = remote(handshakeMs = 1_200, reportMs = 400)
        remote.foreground()
        await { remote.log.entries.any { it.text.startsWith("Gave up") } }
        Thread.sleep(700)
        val log = remote.log.entries.map { it.text }
        val gaveUp = log.indexOfFirst { it.startsWith("Gave up") }
        assertTrue(log[gaveUp], log[gaveUp].endsWith(": sent 148 bytes, received 0 bytes. WireGuard keeps trying"))
        assertTrue("Progress was logged before giving up", log.take(gaveUp).any { it.startsWith("No answer yet") })
        assertFalse("No progress line repeats it", log.getOrNull(gaveUp + 1)?.startsWith("No answer yet") == true)
    }

    @Test
    fun afterGivingUpTheWaitIsLoggedLessOften() {
        backend.answers = false
        val remote = remote(handshakeMs = 200, reportMs = 300)
        remote.foreground()
        await { remote.status is TunnelStatus.Failed }
        // Several of the usual report intervals; the log keeps only 300 entries, which a line
        // every few seconds for as long as the app is open would fill with this alone.
        Thread.sleep(2_000)
        val log = remote.log.entries.map { it.text }
        val after = log.drop(log.indexOfFirst { it.startsWith("Gave up") } + 1)
        assertEquals(listOf<String>(), after.filter { it.startsWith("No answer yet") })
    }

    @Test
    fun aRepeatedLineIsLoggedOnce() {
        var now = 1_000L
        val echoed = mutableListOf<String>()
        val log = TunnelLog(clock = { now }, echo = { echoed += it })
        log.add("Networks changed")
        log.add("Networks changed")
        assertEquals(1, log.entries.size)
        log.add("Direct check: no answer")
        log.add("Networks changed")
        assertEquals(3, log.entries.size)
        now += 5_000
        log.add("Networks changed")
        assertEquals(4, log.entries.size)
        assertEquals(4, echoed.size)
    }

    @Test
    fun theLogHidesKeysAndAddressesWhoeverWritesIt() {
        val key = KeyPair().privateKey.toBase64()
        val log = TunnelLog()
        log.add("from 203.0.113.4 and 2001:db8::5 with $key")
        assertEquals("from public …4 and public IPv6 …5 with (key hidden)", log.entries.single().text)
    }

    @Test
    fun aStartFailuresDetailIsMasked() {
        backend.failure = "The tunnel did not start."
        backend.cause = IllegalStateException("bind to 203.0.113.4:51820 failed")
        val remote = remote()
        remote.foreground()
        await { remote.status is TunnelStatus.Failed }
        val line = remote.log.entries.first { it.text.startsWith("Tunnel did not start") }.text
        assertFalse(line, "203.0.113.4" in line)
        assertTrue(line, "public …4:51820" in line)
    }

    @Test
    fun ipv6AddressesAreMaskedToo() {
        assertEquals("private IPv6 …2/128", maskAddresses("fd00:0:0:0:0:0:0:2/128"))
        assertEquals("[public IPv6 …5]:51820", maskAddresses("[2001:db8::5]:51820"))
        assertEquals("link-local IPv6 …1", maskAddresses("fe80::1"))
        // Times and hardware addresses look alike but are not addresses.
        assertEquals("at 17:31:09.123", maskAddresses("at 17:31:09.123"))
        assertEquals("aa:bb:cc:dd:ee:ff", maskAddresses("aa:bb:cc:dd:ee:ff"))
        assertEquals("a public IPv6 address (…5)", describeHost("2001:db8::5"))
        assertEquals("a private IPv6 address (…7)", describeHost("[fd12::7]"))
    }

    @Test
    fun theReportMasksIpv6AndSaysWhatRoutesEverything() {
        val text = tunnelFile(peer = "Endpoint = [2001:db8::5]:51820\nAllowedIPs = ::/0").replace(
            "Address = 192.168.2.2/32",
            "Address = 192.168.2.2/32, fd00::2/128",
        )
        val remote = remote(tunnel = TunnelSettings(text, "home", enabled = true))
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        val report = tunnelReport(remote, "http://192.168.1.20:5000/", about = listOf(), libraryLines = listOf())
        assertFalse(report, "2001:db8" in report || "fd00" in report || "0:0:0" in report)
        assertTrue(report, "Routes through the tunnel (AllowedIPs): all IPv4 traffic, all IPv6 traffic" in report)
        assertTrue(report, "Tunnel address: private …2/32, private IPv6 …2/128" in report)
        assertTrue(report, "Starting the tunnel to public IPv6 …5, UDP port 51820" in report)
    }

    @Test
    fun theVpnServersNameStaysOutOfTheLog() {
        val text = tunnelFile(peer = "Endpoint = myhome.duckdns.org:51820")
        val remote = remote(tunnel = null)
        assertNull(runBlocking { remote.import("home.conf", text) })
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        val report = tunnelReport(remote, "http://192.168.1.20:5000/", about = listOf(), libraryLines = listOf())
        assertFalse(report, "myhome" in report)
        assertTrue(report, "server is a hostname ending .org, UDP port 51820" in report)
    }

    @Test
    fun aLookupFailureDoesNotQuoteTheServersName() {
        val detail = failureDetail(java.net.UnknownHostException("Unable to resolve host \"frigate.example.com\""), "frigate.example.com")
        assertEquals("UnknownHostException: Unable to resolve host \"a hostname ending .com\"", detail)
        assertEquals(
            "ConnectException: failed to connect to private …80 (port 8971)",
            failureDetail(java.net.ConnectException("failed to connect to 192.168.1.80 (port 8971)"), "192.168.1.80"),
        )
    }

    @Test
    fun theReportRedactsTheNameAndWireGuardsLines() {
        val key = KeyPair().publicKey.toBase64()
        val remote = remote(tunnel = TunnelSettings(tunnelFile(), "203.0.113.9", enabled = true))
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        val report = tunnelReport(
            remote,
            "http://192.168.1.20:5000/",
            about = listOf(),
            libraryLines = listOf("peer $key at 203.0.113.4"),
        )
        assertFalse(report, key in report || "203.0.113" in report)
        assertTrue(report, "Tunnel: \"public …9\", turned on" in report)
    }

    @Test
    fun theReportSaysTheStatusInWords() {
        backend.answers = false
        val remote = remote(handshakeMs = 200)
        remote.foreground()
        await { remote.status is TunnelStatus.Failed }
        val report = tunnelReport(remote, "http://192.168.1.20:5000/", about = listOf(), libraryLines = listOf())
        assertFalse(report, "Failed(message=" in report)
        assertTrue(report, "Status: Failed, the VPN server never answered. The VPN server did not answer." in report)
    }

    @Test
    fun theHarmlessWireGuardErrorSaysSo() {
        val lines = libraryReportLines(
            listOf(
                "10-31 17:31:09.100 E/WireGuard/GoBackend/frigate( 123): " +
                    "UAPIOpen: mkdir /data/data/com.wireguard.android: permission denied",
                "10-31 17:31:09.200 D/WireGuard/GoBackend/frigate( 123): peer(abcd…wxyz) - Sending handshake initiation",
                "10-31 17:31:09.300 D/WireGuard/GoBackend/frigate( 123): Routine: worker 3 - started",
            ),
        )
        assertEquals(2, lines.size)
        val harmless = "permission denied  (harmless: a control socket for the official WireGuard app, which this app does not use)"
        assertTrue(lines[0], lines[0].endsWith(harmless))
        assertFalse(lines[1], "harmless" in lines[1])
    }

    @Test
    fun aFileWithAByteOrderMarkOrWgQuickSettingsIsUsable() {
        val withMark = "\uFEFF" + tunnelFile()
        assertEquals(1, appOnlyTunnel(withMark, "com.jtn.frigateviewer").peers.size)
        assertEquals("vpn.example.com:51820", tunnelEndpoint(withMark))
        val wgQuick = tunnelFile(extraInterface = "Table = off\nPostUp = iptables -A FORWARD -j ACCEPT # a comment\nSaveConfig = true")
        assertEquals(1, appOnlyTunnel(wgQuick.replace("\n", "\r\n"), "com.jtn.frigateviewer").peers.size)
    }

    @Test
    fun aBadFileSaysWhatIsWrongWithoutQuotingIt() {
        fun problem(text: String) = try {
            appOnlyTunnel(text, "com.jtn.frigateviewer")
            null
        } catch (e: TunnelConfigException) {
            e.message
        }
        val file = tunnelFile()
        val key = file.lines().first { it.startsWith("PrivateKey") }
        assertEquals("The file's [Interface] has no PrivateKey.", problem(file.replace(key, "")))
        assertEquals("The file's [Interface] PrivateKey is not a valid WireGuard key.", problem(file.replace(key, "PrivateKey = abc")))
        assertEquals(
            "The file has a section WireGuard does not know, [Peers]. Only [Interface] and [Peer] are allowed.",
            problem(file.replace("[Peer]", "[Peers]")),
        )
        assertEquals(
            "The file's [Interface] has a setting WireGuard does not know: Colour.",
            problem(tunnelFile(extraInterface = "Colour = blue")),
        )
        assertEquals("The file has no [Interface] section, so it is not a whole WireGuard configuration.", problem(""))
        assertEquals("The file's [Peer] Endpoint is not valid.", problem(tunnelFile(peer = "Endpoint = vpn.example.com")))
        // A key above the first section: the parser quotes the whole line, which must not get out.
        val outside = problem("$key\n$file")
        assertEquals("This is not a WireGuard configuration file.", outside)
    }

    @Test
    fun theTunnelIsNamedAfterTheFileHoweverItIsCased() {
        assertEquals("UDMPro-Frig", tunnelName("UDMPro-Frig.CONF"))
        assertEquals("home", tunnelName("home.conf"))
        assertEquals("home.conf.txt", tunnelName("home.conf.txt"))
    }

    @Test
    fun closingSaysWhyInWords() {
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        remote.setEnabled(false)
        await { remote.status == TunnelStatus.Off }
        val log = remote.log.entries.map { it.text }
        assertTrue(log.toString(), "Closing the tunnel: it is turned off, or the app is signed out" in log)
        assertFalse(log.toString(), log.any { it == "Closing the tunnel: Off" })
    }

    @Test
    fun afterTheIdleCloseItIsNotShownConnected() {
        val remote = remote(idleMs = 50)
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        remote.background()
        await { backend.downs == 1 }
        await { remote.status == TunnelStatus.Checking }
    }

    @Test
    fun throughAnotherVpnTheTunnelStaysOffAndAndroidIsNotAsked() {
        // UniFi Teleport, Tailscale or the WireGuard app is on and reaches the server.
        route.reach = Reach.DIRECT
        route.otherVpn = true
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.OtherVpn }
        assertTrue(backend.ups.isEmpty())
        // Asking Android for the VPN permission would hand the VPN to this app and turn that one off.
        assertEquals(0, backend.permissionAsks.get())
        assertTrue(remote.log.entries.any { it.text == "Reached through another VPN, so the app's tunnel stays off" })
    }

    @Test
    fun androidIsAskedForThePermissionOnlyWhenTheTunnelIsNeeded() {
        route.reach = Reach.DIRECT
        val remote = remote()
        // In the background nothing is checked, and Android is not asked either.
        remote.check()
        Thread.sleep(200)
        remote.foreground()
        await { remote.status == TunnelStatus.Home }
        assertEquals(0, backend.permissionAsks.get())
        assertNull(remote.permitted)

        route.reach = Reach.NOT_DIRECT
        route.onChange!!()
        await { remote.status == TunnelStatus.Connected }
        assertEquals(1, backend.permissionAsks.get())
        assertEquals(true, remote.permitted)
    }

    @Test
    fun anotherVpnThatDoesNotReachTheServerIsNotTurnedOffUnasked() {
        route.otherVpn = true
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.OtherVpnInTheWay }
        assertTrue(backend.ups.isEmpty())
        assertEquals(0, backend.permissionAsks.get())
        assertTrue(remote.log.entries.any { it.text.startsWith("Another VPN is on and does not reach the server") })

        // Another check changes nothing, and does not log it again.
        route.onChange!!()
        Thread.sleep(1_300)
        assertEquals(TunnelStatus.OtherVpnInTheWay, remote.status)
        assertEquals(1, remote.log.entries.count { it.text.startsWith("Another VPN is on") })

        // The user chooses the tunnel, which Android lets turn the other VPN off.
        remote.startTunnel()
        await { remote.status == TunnelStatus.Connected }
        assertEquals(1, backend.ups.size)
    }

    @Test
    fun aVpnTakingOverFromTheTunnelIsUsedNotFought() {
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }

        // Teleport is turned on: Android stops the app's tunnel, and the server answers through it.
        route.reach = Reach.DIRECT
        route.otherVpn = true
        backend.stopOutside()
        await { remote.status == TunnelStatus.OtherVpn }
        assertEquals("Not started again over it", 1, backend.ups.size)
        assertTrue(remote.log.entries.any { it.text == "Another VPN took over from the tunnel" })
        // Away from the tunnel, then onto the other VPN: open connections follow.
        assertEquals(3, remote.routeChanges)

        // Teleport is turned off again: the app's tunnel takes over by itself.
        route.reach = Reach.NOT_DIRECT
        route.otherVpn = false
        route.onChange!!()
        await { remote.status == TunnelStatus.Connected }
        assertEquals(2, backend.ups.size)
    }

    @Test
    fun turningAnotherVpnOnWhileTheTunnelFailsReloadsOverIt() {
        backend.answers = false
        val remote = remote(handshakeMs = 200)
        remote.foreground()
        await { remote.status is TunnelStatus.Failed }
        assertEquals(0, remote.routeChanges)

        route.reach = Reach.DIRECT
        route.otherVpn = true
        backend.stopOutside()
        await { remote.status == TunnelStatus.OtherVpn }
        // What failed is loaded again, now through the other VPN.
        assertEquals(1, remote.routeChanges)
    }

    @Test
    fun aNetworkChangeWhileWaitingKeepsTheWaitGoing() {
        backend.answers = false
        val remote = remote(handshakeMs = 1_500)
        remote.foreground()
        await { remote.log.entries.any { it.text.startsWith("Tunnel up") } }
        Thread.sleep(600)
        remote.check()
        await { remote.status is TunnelStatus.Failed }

        val log = remote.log.entries
        assertEquals(log.map { it.text }.toString(), 1, log.count { it.text.startsWith("Tunnel up") })
        val waited = log.first { it.text.startsWith("Gave up") }.at - log.first { it.text.startsWith("Tunnel up") }.at
        assertTrue("Gave up after $waited ms, not 15 s from the change", waited < 2_000)

        // Once given up, another check leaves it shown as failed rather than connecting again.
        remote.check()
        Thread.sleep(300)
        assertTrue("${remote.status}", remote.status is TunnelStatus.Failed)
        assertEquals(1, log.count { it.text.startsWith("Gave up") })
    }

    @Test
    fun afterNoNetworkTheWaitStartsAgain() {
        backend.answers = false
        val remote = remote(handshakeMs = 200)
        remote.foreground()
        await { remote.status is TunnelStatus.Failed }

        route.reach = Reach.NO_NETWORK
        remote.check()
        await { remote.status == TunnelStatus.NoNetwork }
        route.reach = Reach.NOT_DIRECT
        remote.check()
        await { remote.status == TunnelStatus.Connecting }
        assertEquals(2, remote.log.entries.count { it.text.startsWith("Tunnel up") })
    }

    @Test
    fun aCheckCancelledWhileTheTunnelStartsStillClosesItLater() {
        backend.upMs = 500
        val remote = remote()
        remote.foreground()
        await { remote.log.entries.any { it.text.startsWith("Starting the tunnel") } }
        // Home again while it is still starting: the newer check cancels the one starting it.
        route.reach = Reach.DIRECT
        remote.check()
        await { remote.status == TunnelStatus.Home }
        await { backend.downs == 1 }
        assertEquals(1, backend.ups.size)
    }

    @Test
    fun theCheckKnowsWhetherTheTunnelIsUp() {
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        remote.check()
        await { route.checkedWithTunnel.size >= 2 }
        assertEquals(listOf(false, true), route.checkedWithTunnel.take(2))
    }

    @Test
    fun theReportSaysWhatItKnowsWithoutAskingAndroid() {
        route.reach = Reach.DIRECT
        route.otherVpn = true
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.OtherVpn }
        val report = tunnelReport(remote, "http://192.168.1.20:5000/", about = listOf(), libraryLines = listOf())
        assertTrue(report, "Android VPN permission: not asked yet, since the tunnel has not been needed" in report)
        assertTrue(report, "Another app's VPN: on" in report)
        assertTrue(report, "Status: OtherVpn" in report)
        assertEquals(0, backend.permissionAsks.get())
    }

    @Test
    fun turningItOnAgainAfterAStopOutsideStartsIt() {
        val remote = remote()
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        backend.stopOutside()
        await { remote.status == TunnelStatus.StoppedOutside }
        remote.setEnabled(false)
        await { remote.status == TunnelStatus.Off }
        remote.setEnabled(true)
        await { remote.status == TunnelStatus.Connected }
        assertEquals(2, backend.ups.size)
    }

    @Test
    fun aStopOutsideIsForgottenAfterAWhileInTheBackground() {
        val remote = remote(idleMs = 50)
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
        backend.stopOutside()
        await { remote.status == TunnelStatus.StoppedOutside }
        remote.background()
        Thread.sleep(200)
        remote.foreground()
        await { remote.status == TunnelStatus.Connected }
    }

    @Test
    fun theWayToTheServerIsCountedWhenItStartsWorking() {
        val paths = PathChanges()
        paths.moveTo(Path.DIRECT)
        assertEquals("The first way found is not a change", 0, paths.count)
        paths.moveTo(Path.NONE)
        assertEquals("A way lost is not reloaded over", 0, paths.count)
        paths.moveTo(Path.OTHER_VPN)
        assertEquals(1, paths.count)
        paths.moveTo(Path.TUNNEL)
        paths.moveTo(null)
        assertEquals("Leaving the tunnel ends its connections", 3, paths.count)
        paths.moveTo(Path.DIRECT)
        assertEquals("Not known before", 3, paths.count)
    }
}
