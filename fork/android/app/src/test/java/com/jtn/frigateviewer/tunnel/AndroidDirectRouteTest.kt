package com.jtn.frigateviewer.tunnel

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.core.app.ApplicationProvider
import java.net.InetAddress
import java.net.ServerSocket
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowNetworkCapabilities

/** The direct check on Android's networks: another app's VPN as the way the app's connections go. */
@RunWith(RobolectricTestRunner::class)
class AndroidDirectRouteTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)

    private fun caps(transport: Int, validated: Boolean = true): NetworkCapabilities =
        ShadowNetworkCapabilities.newInstance().also { caps ->
            shadowOf(caps).addTransportType(transport)
            if (validated) shadowOf(caps).addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }

    @Test
    fun anotherAppsVpnAsTheWayTheAppGoesIsSeen() {
        val route = AndroidDirectRoute(context)
        val default = connectivity.activeNetwork!!
        shadowOf(connectivity).setNetworkCapabilities(default, caps(NetworkCapabilities.TRANSPORT_VPN))
        assertTrue(route.otherVpnOn(ownTunnelUp = false))
        // Android does not say whose it is, so with the app's own tunnel up it is taken to be that.
        assertFalse(route.otherVpnOn(ownTunnelUp = true))

        shadowOf(connectivity).setNetworkCapabilities(default, caps(NetworkCapabilities.TRANSPORT_WIFI))
        assertFalse(route.otherVpnOn(ownTunnelUp = false))
    }

    @Test
    fun theServerIsTriedThroughAnotherAppsVpn() {
        val route = AndroidDirectRoute(context)
        shadowOf(connectivity).setNetworkCapabilities(connectivity.activeNetwork!!, caps(NetworkCapabilities.TRANSPORT_VPN))
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            val probe = runBlocking { route.check("http://127.0.0.1:${server.localPort}/", ownTunnelUp = false) }
            assertEquals(Reach.DIRECT, probe.reach)
            assertTrue(probe.otherVpn)
            assertTrue(probe.detail, probe.detail.startsWith("answered through another VPN to http port ${server.localPort}"))
        }
    }

    @Test
    fun withNoNetworkItSaysSo() {
        shadowOf(connectivity).setActiveNetworkInfo(null)
        val probe = runBlocking { AndroidDirectRoute(context).check("https://192.0.2.10:8971/", ownTunnelUp = false) }
        assertEquals(Reach.NO_NETWORK, probe.reach)
    }

    @Test
    fun watchingTellsChangesButNotTheNetworksThereAlready() {
        val route = AndroidDirectRoute(context)
        val wifi = ShadowNetwork.newInstance(WIFI_ID)
        val vpn = ShadowNetwork.newInstance(VPN_ID)
        // Known before the watch begins.
        shadowOf(connectivity).networkCallbacks.forEach { it.onCapabilitiesChanged(wifi, caps(NetworkCapabilities.TRANSPORT_WIFI)) }

        var changes = 0
        val watch = route.watch { changes++ }
        // Android replays each network to a new callback: not a change.
        shadowOf(connectivity).networkCallbacks.forEach { it.onCapabilitiesChanged(wifi, caps(NetworkCapabilities.TRANSPORT_WIFI)) }
        assertEquals(0, changes)

        // Teleport comes up, and goes again: both are changes, and an update saying the same is not.
        shadowOf(connectivity).networkCallbacks.forEach { it.onCapabilitiesChanged(vpn, caps(NetworkCapabilities.TRANSPORT_VPN)) }
        shadowOf(connectivity).networkCallbacks.forEach { it.onCapabilitiesChanged(vpn, caps(NetworkCapabilities.TRANSPORT_VPN)) }
        assertEquals(1, changes)
        shadowOf(connectivity).networkCallbacks.forEach { it.onLost(vpn) }
        assertEquals(2, changes)

        val before = shadowOf(connectivity).networkCallbacks.size
        watch.close()
        assertEquals(before - 1, shadowOf(connectivity).networkCallbacks.size)
    }

    private companion object {
        const val WIFI_ID = 100
        const val VPN_ID = 101
    }
}
