package com.jtn.frigateviewer.tunnel

import java.net.ConnectException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The direct check tries each address the server's name has, as a browser would. */
class DirectRouteTest {
    private val ipv6 = InetAddress.getByName("2001:db8::5")
    private val ipv4 = InetAddress.getByName("192.0.2.5")

    @Test
    fun anAddressThatFailsIsFollowedByTheNext() {
        val tried = mutableListOf<Pair<InetAddress, Int>>()
        connectToAny(listOf(ipv6, ipv4), budgetMs = 2_000) { address, timeoutMs ->
            tried += address to timeoutMs
            if (address == ipv6) throw ConnectException("Network is unreachable")
        }
        assertEquals(listOf(ipv6, ipv4), tried.map { it.first })
        assertTrue("The first gets a share of the time, not all of it", tried[0].second <= 1_000)
    }

    @Test
    fun whenNoneAnswersTheLastFailureIsTold() {
        val failure = runCatching {
            connectToAny(listOf(ipv6, ipv4), budgetMs = 500) { address, _ ->
                throw SocketTimeoutException("no answer from ${address.hostAddress}")
            }
        }.exceptionOrNull()
        assertEquals("no answer from 192.0.2.5", failure?.message)
    }

    @Test
    fun theTimeLimitCoversEveryAttempt() {
        var attempts = 0
        val failure = runCatching {
            connectToAny(listOf(ipv6, ipv4, ipv4), budgetMs = 100) { _, timeoutMs ->
                attempts++
                Thread.sleep(timeoutMs.toLong() + 60)
                throw SocketTimeoutException("timed out")
            }
        }.exceptionOrNull()
        assertTrue(failure is SocketTimeoutException)
        assertTrue("Stopped when the time was up, after $attempts", attempts < 3)
    }

    private val wifi = NetView(WIFI, vpn = false, owner = Owner.UNKNOWN, validated = true)
    private val mobile = NetView("mobile data", vpn = false, owner = Owner.UNKNOWN, validated = true)
    private val teleport = NetView("a VPN", vpn = true, owner = Owner.UNKNOWN, validated = true)
    private val ownTunnel = NetView("a VPN", vpn = true, owner = Owner.THIS_APP, validated = true)

    @Test
    fun anotherAppsVpnIsTriedTheWayTheAppsConnectionsGo() {
        // Teleport carries the app's connections, so the check goes through it, not over Wi-Fi.
        assertEquals(ProbePlan.OtherVpn, planProbe("vpn" to teleport, mapOf("vpn" to teleport, "wifi" to wifi), ownTunnelUp = false))
        val known = teleport.copy(owner = Owner.OTHER_APP)
        assertEquals(ProbePlan.OtherVpn, planProbe("vpn" to known, mapOf("vpn" to known, "wifi" to wifi), ownTunnelUp = true))
    }

    @Test
    fun theAppsOwnTunnelIsNeverTheDirectWay() {
        val networks = mapOf("tunnel" to ownTunnel, "wifi" to wifi, "mobile" to mobile)
        assertEquals(ProbePlan.Over("wifi", WIFI), planProbe("tunnel" to ownTunnel, networks, ownTunnelUp = true))
        // A VPN Android does not say the owner of is taken to be the app's own while that runs.
        val unnamed = mapOf("tunnel" to teleport, "mobile" to mobile)
        assertEquals(ProbePlan.Over("mobile", "mobile data"), planProbe("tunnel" to teleport, unnamed, ownTunnelUp = true))
        assertEquals(ProbePlan.NoNetwork, planProbe("tunnel" to ownTunnel, mapOf("tunnel" to ownTunnel), ownTunnelUp = true))
    }

    @Test
    fun withoutAVpnTheDefaultNetworkIsTried() {
        val networks = mapOf("wifi" to wifi, "mobile" to mobile)
        assertEquals(ProbePlan.Over("mobile", "mobile data"), planProbe("mobile" to mobile, networks, ownTunnelUp = false))
        assertEquals(ProbePlan.NoNetwork, planProbe<String>(null, mapOf(), ownTunnelUp = false))
    }

    @Test
    fun underTheTunnelTheNetworkAndroidWouldPickIsTried() {
        // Wi-Fi that does not reach the internet comes after mobile data that does, as Android has it.
        val captive = wifi.copy(validated = false)
        val networks = mapOf("tunnel" to ownTunnel, "wifi" to captive, "mobile" to mobile)
        assertEquals(ProbePlan.Over("mobile", "mobile data"), planProbe("tunnel" to ownTunnel, networks, ownTunnelUp = true))
        val both = mapOf("mobile" to mobile, "wifi" to wifi)
        assertEquals(ProbePlan.Over("wifi", WIFI), planProbe<String>(null, both, ownTunnelUp = true))
    }

    @Test
    fun theAppsOwnTunnelIsNoNetworkChange() {
        val before = networkState(mapOf("wifi" to wifi))
        assertEquals(before, networkState(mapOf("wifi" to wifi, "tunnel" to ownTunnel)))
        assertFalse(before == networkState(mapOf("wifi" to wifi, "vpn" to teleport)))
        assertFalse(before == networkState(mapOf("wifi" to wifi.copy(validated = false))))
    }

    @Test
    fun aServerThatAcceptsIsReachedThatWay() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            val way = ProbeWay("through another VPN", otherVpn = true, lookup = { arrayOf(InetAddress.getLoopbackAddress()) }) { Socket() }
            val probe = runBlocking { probe("https://frigate.example.org:${server.localPort}/", way) }
            assertEquals(Reach.DIRECT, probe.reach)
            assertTrue(probe.otherVpn)
            assertTrue(
                probe.detail,
                probe.detail.startsWith("answered through another VPN to https port ${server.localPort} at a hostname ending .org in "),
            )
        }
    }

    @Test
    fun aNameThatDoesNotResolveThatWayIsNotReached() {
        val way =
            ProbeWay("over mobile data", otherVpn = false, lookup = {
                throw UnknownHostException("Unable to resolve host \"frigate.home.arpa\"")
            }) {
                Socket()
            }
        val probe = runBlocking { probe("https://frigate.home.arpa:8971/", way) }
        assertEquals(Reach.NOT_DIRECT, probe.reach)
        assertFalse(probe.detail, "frigate.home" in probe.detail)
        assertTrue(probe.detail, probe.detail.endsWith("(UnknownHostException: Unable to resolve host \"a hostname ending .arpa\")"))
    }

    @Test
    fun aServerThatNeverAnswersIsGivenUpOnInTime() {
        val way = ProbeWay("over Wi-Fi", otherVpn = false, lookup = {
            Thread.sleep(5_000)
            arrayOf()
        }) { Socket() }
        val started = System.currentTimeMillis()
        val probe = runBlocking { probe("https://198.51.100.7:8971/", way, budgetMs = 100) }
        assertTrue(System.currentTimeMillis() - started < 2_000)
        assertEquals("not reached over Wi-Fi to https port 8971 at a public IPv4 address (…7) (no answer in 100 ms)", probe.detail)
        assertEquals(Reach.NOT_DIRECT, runBlocking { probe("not a url", way) }.reach)
    }
}
