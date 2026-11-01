package com.jtn.frigateviewer.tunnel

import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.data.TunnelSettings
import com.jtn.frigateviewer.ui.testSettingsStore
import com.wireguard.crypto.KeyPair
import java.io.File
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RemoteAccessTest {
    @get:Rule val temp = TemporaryFolder()

    private var made: SettingsStore? = null

    /** The store on the test's dispatcher, reads included, closed with the test's background scope. */
    private val TestScope.store: SettingsStore
        get() = made ?: testSettingsStore(
            File(temp.root, "server.preferences_pb"),
            backgroundScope,
            StandardTestDispatcher(testScheduler),
        ).also { made = it }
    private val backend = FakeBackend()
    private val route = FakeRoute(Reach.NOT_DIRECT)

    private suspend fun TestScope.remote(
        tunnel: TunnelSettings? = TunnelSettings(
            tunnelFile(),
            "home",
            enabled = true,
        ),
        idleMs: Long = 60_000,
        handshakeMs: Long = 15_000,
        reportMs: Long = 5_000,
    ): RemoteAccess {
        store.save(ServerSettings(baseUrl = "http://192.168.1.20:5000/"))
        store.saveTunnel(tunnel)
        // The log and the wait for an answer both on virtual time.
        val clock = { testScheduler.currentTime }
        return RemoteAccess(
            backgroundScope,
            store,
            backend,
            route,
            "com.jtn.frigateviewer",
            idleMs,
            handshakeMs,
            reportMs,
            log = TunnelLog(clock = clock),
            clock = clock,
        ).also { it.start() }
    }

    @Test
    fun theFileIsSavedEncryptedAndNeverPrinted() = runTest {
        val text = tunnelFile()
        store.saveTunnel(TunnelSettings(text, "home", enabled = true))
        val key = text.lines().first { it.startsWith("PrivateKey") }.substringAfter("= ")
        val onDisk = File(temp.root, "server.preferences_pb").readBytes().decodeToString()
        assertFalse(key in onDisk)
        val saved = store.tunnel.first()!!
        assertEquals(text, saved.config)
        assertFalse(key in saved.toString())

        store.saveTunnel(null)
        assertNull(store.tunnel.first())
    }

    @Test
    fun awayFromHomeTheTunnelComesUpOnceAndClosesBackHome() = runTest {
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        assertEquals(1, backend.ups.size)
        assertEquals(setOf("com.jtn.frigateviewer"), backend.ups.single().`interface`.includedApplications)
        assertEquals(1, remote.routeChanges)

        // Another network while still away: the running tunnel is kept.
        remote.check()
        advanceUntil { remote.status == TunnelStatus.Connected }
        assertEquals(1, backend.ups.size)

        route.reach = Reach.DIRECT
        route.onChange!!()
        advanceUntil { remote.status == TunnelStatus.Home }
        assertEquals(1, backend.downs.get())
        assertEquals(2, remote.routeChanges)
    }

    @Test
    fun aVpnStoppedOutsideTheAppIsNotShownConnectedNorStartedAgainUnasked() = runTest {
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }

        // Stopped from outside (another VPN app, or the system's VPN settings): it is not
        // assumed still running, the lost route is reported, and it is not started again
        // over the user's choice.
        backend.stopOutside()
        advanceUntil { remote.status == TunnelStatus.StoppedOutside }
        assertEquals(1, backend.ups.size)
        assertTrue(remote.log.entries.any { it.text == "The VPN was turned off outside the app" })
        assertEquals("The lost route is reported", 2, remote.routeChanges)

        // Started again from Settings.
        remote.startTunnel()
        advanceUntil { backend.ups.size == 2 && remote.status == TunnelStatus.Connected }

        // Stopped again along with the app's VPN permission: starting it asks for the permission.
        backend.permitted = false
        backend.stopOutside()
        advanceUntil { remote.status == TunnelStatus.StoppedOutside }
        remote.startTunnel()
        advanceUntil { remote.status == TunnelStatus.NeedsPermission }
        assertEquals(2, backend.ups.size)
    }

    @Test
    fun aServerThatNeverAnswersIsReportedNotConnected() = runTest {
        backend.answers = false
        val remote = remote(handshakeMs = 200)
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connecting }
        advanceUntil { remote.status is TunnelStatus.Failed }
        assertTrue((remote.status as TunnelStatus.Failed).message.startsWith("The VPN server did not answer."))
        // Nothing moves to a tunnel that carries nothing.
        assertEquals(0, remote.routeChanges)

        // WireGuard keeps trying; once the server answers, it is used.
        backend.answers = true
        advanceUntil { remote.status == TunnelStatus.Connected }
        assertEquals(1, remote.routeChanges)

        // The log tells the story: checked, started, gave up, then answered.
        val log = remote.log.entries.map { it.text }
        assertTrue(log.any { it == "Direct check: test route: NOT_DIRECT" })
        assertTrue(log.any { it == "Starting the tunnel to a hostname ending .com, UDP port 51820" })
        assertTrue(log.any { it.startsWith("Gave up waiting") })
        assertTrue(log.any { it.startsWith("VPN server answered") && "received 92 bytes" in it })
    }

    @Test
    fun theReportGivesKindsOfAddressAndNeverTheKey() = runTest {
        val text = tunnelFile(peer = "Endpoint = 100.72.9.14:51820")
        val remote = remote(tunnel = TunnelSettings(text, "home", enabled = true))
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
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
    fun atHomeTheTunnelStaysDown() = runTest {
        route.reach = Reach.DIRECT
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Home }
        assertTrue(backend.ups.isEmpty())
        assertEquals(0, remote.routeChanges)
    }

    @Test
    fun turningItOffClosesTheTunnel() = runTest {
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        remote.setEnabled(false)
        advanceUntil { remote.status == TunnelStatus.Off }
        assertEquals(1, backend.downs.get())
        assertFalse(store.tunnel.first()!!.enabled)
    }

    @Test
    fun withoutAndroidsPermissionNothingStarts() = runTest {
        backend.permitted = false
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.NeedsPermission }
        assertTrue(backend.ups.isEmpty())

        backend.permitted = true
        remote.check()
        advanceUntil { remote.status == TunnelStatus.Connected }
    }

    @Test
    fun aFailedStartIsShownAndTriedAgainLater() = runTest {
        backend.failure = "Could not look up the VPN server's address."
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status is TunnelStatus.Failed }
        assertEquals("Could not look up the VPN server's address.", (remote.status as TunnelStatus.Failed).message)

        backend.failure = null
        route.onChange!!()
        advanceUntil { remote.status == TunnelStatus.Connected }
    }

    @Test
    fun theTunnelClosesAfterTheAppHasBeenAwayAWhile() = runTest {
        val remote = remote(idleMs = 50)
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        remote.background()
        assertNull(route.onChange)
        advanceUntil { backend.downs.get() == 1 }

        remote.foreground()
        advanceUntil { backend.ups.size == 2 }
    }

    @Test
    fun importingChecksTheFileBeforeSavingIt() = runTest {
        val remote = remote(tunnel = null)
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.NotSetUp }
        assertEquals("This is not a WireGuard configuration file.", remote.import("notes.txt", "hello"))
        assertNull(store.tunnel.first())

        assertNull(remote.import("home.conf", tunnelFile()))
        advanceUntil { remote.status == TunnelStatus.Connected }
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
    fun givingUpIsOneLineWithTheFigures() = runTest {
        backend.answers = false
        val remote = remote(handshakeMs = 1_200, reportMs = 400)
        remote.foreground()
        advanceUntil { remote.log.entries.any { it.text.startsWith("Gave up") } }
        elapse(700)
        val log = remote.log.entries.map { it.text }
        val gaveUp = log.indexOfFirst { it.startsWith("Gave up") }
        assertTrue(log[gaveUp], log[gaveUp].endsWith(": sent 148 bytes, received 0 bytes. WireGuard keeps trying"))
        assertTrue("Progress was logged before giving up", log.take(gaveUp).any { it.startsWith("No answer yet") })
        assertFalse("No progress line repeats it", log.getOrNull(gaveUp + 1)?.startsWith("No answer yet") == true)
    }

    @Test
    fun afterGivingUpTheWaitIsLoggedLessOften() = runTest {
        backend.answers = false
        val remote = remote(handshakeMs = 200, reportMs = 300)
        remote.foreground()
        advanceUntil { remote.status is TunnelStatus.Failed }
        // Several of the usual report intervals; the log keeps only 300 entries, which a line
        // every few seconds for as long as the app is open would fill with this alone.
        elapse(2_000)
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
    fun aStartFailuresDetailIsMasked() = runTest {
        backend.failure = "The tunnel did not start."
        backend.cause = IllegalStateException("bind to 203.0.113.4:51820 failed")
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status is TunnelStatus.Failed }
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
    fun theReportMasksIpv6AndSaysWhatRoutesEverything() = runTest {
        val text = tunnelFile(peer = "Endpoint = [2001:db8::5]:51820\nAllowedIPs = ::/0").replace(
            "Address = 192.168.2.2/32",
            "Address = 192.168.2.2/32, fd00::2/128",
        )
        val remote = remote(tunnel = TunnelSettings(text, "home", enabled = true))
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        val report = tunnelReport(remote, "http://192.168.1.20:5000/", about = listOf(), libraryLines = listOf())
        assertFalse(report, "2001:db8" in report || "fd00" in report || "0:0:0" in report)
        assertTrue(report, "Routes through the tunnel (AllowedIPs): all IPv4 traffic, all IPv6 traffic" in report)
        assertTrue(report, "Tunnel address: private …2/32, private IPv6 …2/128" in report)
        assertTrue(report, "Starting the tunnel to public IPv6 …5, UDP port 51820" in report)
    }

    @Test
    fun theVpnServersNameStaysOutOfTheLog() = runTest {
        val text = tunnelFile(peer = "Endpoint = myhome.duckdns.org:51820")
        val remote = remote(tunnel = null)
        assertNull(remote.import("home.conf", text))
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
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
    fun theReportRedactsTheNameAndWireGuardsLines() = runTest {
        val key = KeyPair().publicKey.toBase64()
        val remote = remote(tunnel = TunnelSettings(tunnelFile(), "203.0.113.9", enabled = true))
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
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
    fun theReportSaysTheStatusInWords() = runTest {
        backend.answers = false
        val remote = remote(handshakeMs = 200)
        remote.foreground()
        advanceUntil { remote.status is TunnelStatus.Failed }
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
    fun closingSaysWhyInWords() = runTest {
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        remote.setEnabled(false)
        advanceUntil { remote.status == TunnelStatus.Off }
        val log = remote.log.entries.map { it.text }
        assertTrue(log.toString(), "Closing the tunnel: it is turned off, or the app is signed out" in log)
        assertFalse(log.toString(), log.any { it == "Closing the tunnel: Off" })
    }

    @Test
    fun afterTheIdleCloseItIsNotShownConnected() = runTest {
        val remote = remote(idleMs = 50)
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        remote.background()
        advanceUntil { backend.downs.get() == 1 }
        advanceUntil { remote.status == TunnelStatus.Checking }
    }

    @Test
    fun throughAnotherVpnTheTunnelStaysOffAndAndroidIsNotAsked() = runTest {
        // UniFi Teleport, Tailscale or the WireGuard app is on and reaches the server.
        route.reach = Reach.DIRECT
        route.otherVpn = true
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.OtherVpn }
        assertTrue(backend.ups.isEmpty())
        // Asking Android for the VPN permission would hand the VPN to this app and turn that one off.
        assertEquals(0, backend.permissionAsks.get())
        assertTrue(remote.log.entries.any { it.text == "Reached through another VPN, so the app's tunnel stays off" })
    }

    @Test
    fun androidIsAskedForThePermissionOnlyWhenTheTunnelIsNeeded() = runTest {
        route.reach = Reach.DIRECT
        val remote = remote()
        // In the background nothing is checked, and Android is not asked either.
        remote.check()
        elapse(200)
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Home }
        assertEquals(0, backend.permissionAsks.get())
        assertNull(remote.permitted)

        route.reach = Reach.NOT_DIRECT
        route.onChange!!()
        advanceUntil { remote.status == TunnelStatus.Connected }
        assertEquals(1, backend.permissionAsks.get())
        assertEquals(true, remote.permitted)
    }

    @Test
    fun anotherVpnThatDoesNotReachTheServerIsNotTurnedOffUnasked() = runTest {
        route.otherVpn = true
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.OtherVpnInTheWay }
        assertTrue(backend.ups.isEmpty())
        assertEquals(0, backend.permissionAsks.get())
        assertTrue(remote.log.entries.any { it.text.startsWith("Another VPN is on and does not reach the server") })

        // Another check changes nothing, and does not log it again.
        route.onChange!!()
        elapse(1_300)
        assertEquals(TunnelStatus.OtherVpnInTheWay, remote.status)
        assertEquals(1, remote.log.entries.count { it.text.startsWith("Another VPN is on") })

        // The user chooses the tunnel, which Android lets turn the other VPN off.
        remote.startTunnel()
        advanceUntil { remote.status == TunnelStatus.Connected }
        assertEquals(1, backend.ups.size)
    }

    @Test
    fun aVpnTakingOverFromTheTunnelIsUsedNotFought() = runTest {
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }

        // Teleport is turned on: Android stops the app's tunnel, and the server answers through it.
        route.reach = Reach.DIRECT
        route.otherVpn = true
        backend.stopOutside()
        advanceUntil { remote.status == TunnelStatus.OtherVpn }
        assertEquals("Not started again over it", 1, backend.ups.size)
        // A check already under way may see the other VPN before Android's stop
        // arrives; either way the line says the other VPN is used.
        assertTrue(
            remote.log.entries.any {
                it.text == "Another VPN took over from the tunnel" || it.text.startsWith("Reached through another VPN")
            },
        )
        // Away from the tunnel, then onto the other VPN: open connections follow.
        assertEquals(3, remote.routeChanges)

        // Teleport is turned off again: the app's tunnel takes over by itself.
        route.reach = Reach.NOT_DIRECT
        route.otherVpn = false
        route.onChange!!()
        advanceUntil { remote.status == TunnelStatus.Connected }
        assertEquals(2, backend.ups.size)
    }

    @Test
    fun turningAnotherVpnOnWhileTheTunnelFailsReloadsOverIt() = runTest {
        backend.answers = false
        val remote = remote(handshakeMs = 200)
        remote.foreground()
        advanceUntil { remote.status is TunnelStatus.Failed }
        assertEquals(0, remote.routeChanges)

        route.reach = Reach.DIRECT
        route.otherVpn = true
        backend.stopOutside()
        advanceUntil { remote.status == TunnelStatus.OtherVpn }
        // What failed is loaded again, now through the other VPN.
        assertEquals(1, remote.routeChanges)
    }

    @Test
    fun aNetworkChangeWhileWaitingKeepsTheWaitGoing() = runTest {
        backend.answers = false
        val remote = remote(handshakeMs = 1_500)
        remote.foreground()
        advanceUntil { remote.log.entries.any { it.text.startsWith("Tunnel up") } }
        elapse(600)
        remote.check()
        advanceUntil { remote.status is TunnelStatus.Failed }

        val log = remote.log.entries
        assertEquals(log.map { it.text }.toString(), 1, log.count { it.text.startsWith("Tunnel up") })
        val waited = log.first { it.text.startsWith("Gave up") }.at - log.first { it.text.startsWith("Tunnel up") }.at
        assertTrue("Gave up after $waited ms, not 15 s from the change", waited < 2_000)

        // Once given up, another check leaves it shown as failed rather than connecting again.
        remote.check()
        elapse(300)
        assertTrue("${remote.status}", remote.status is TunnelStatus.Failed)
        assertEquals(1, remote.log.entries.count { it.text.startsWith("Gave up") })
    }

    @Test
    fun afterNoNetworkTheWaitStartsAgain() = runTest {
        backend.answers = false
        val remote = remote(handshakeMs = 200)
        remote.foreground()
        advanceUntil { remote.status is TunnelStatus.Failed }

        route.reach = Reach.NO_NETWORK
        remote.check()
        advanceUntil { remote.status == TunnelStatus.NoNetwork }
        route.reach = Reach.NOT_DIRECT
        remote.check()
        advanceUntil { remote.status == TunnelStatus.Connecting }
        assertEquals(2, remote.log.entries.count { it.text.startsWith("Tunnel up") })
    }

    @Test
    fun aCheckCancelledWhileTheTunnelStartsStillClosesItLater() = runTest {
        backend.upMs = 500
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.log.entries.any { it.text.startsWith("Starting the tunnel") } }
        // Home again while it is still starting: the newer check cancels the one starting it.
        route.reach = Reach.DIRECT
        remote.check()
        advanceUntil { remote.status == TunnelStatus.Home }
        advanceUntil { backend.downs.get() == 1 }
        assertEquals(1, backend.ups.size)
    }

    @Test
    fun theCheckKnowsWhetherTheTunnelIsUp() = runTest {
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        remote.check()
        advanceUntil { route.checkedWithTunnel.size >= 2 }
        assertEquals(listOf(false, true), route.checkedWithTunnel.take(2))
    }

    @Test
    fun theReportSaysWhatItKnowsWithoutAskingAndroid() = runTest {
        route.reach = Reach.DIRECT
        route.otherVpn = true
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.OtherVpn }
        val report = tunnelReport(remote, "http://192.168.1.20:5000/", about = listOf(), libraryLines = listOf())
        assertTrue(report, "Android VPN permission: not asked yet, since the tunnel has not been needed" in report)
        assertTrue(report, "Another app's VPN: on" in report)
        assertTrue(report, "Status: OtherVpn" in report)
        assertEquals(0, backend.permissionAsks.get())
    }

    @Test
    fun turningItOnAgainAfterAStopOutsideStartsIt() = runTest {
        val remote = remote()
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        backend.stopOutside()
        advanceUntil { remote.status == TunnelStatus.StoppedOutside }
        remote.setEnabled(false)
        advanceUntil { remote.status == TunnelStatus.Off }
        remote.setEnabled(true)
        advanceUntil { remote.status == TunnelStatus.Connected }
        assertEquals(2, backend.ups.size)
    }

    @Test
    fun aStopOutsideIsForgottenAfterAWhileInTheBackground() = runTest {
        val remote = remote(idleMs = 50)
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        backend.stopOutside()
        advanceUntil { remote.status == TunnelStatus.StoppedOutside }
        remote.background()
        elapse(200)
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
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
