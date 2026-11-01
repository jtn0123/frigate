package com.jtn.frigateviewer.tunnel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Reading the WireGuard file into a tunnel that carries only this app. */
@RunWith(RobolectricTestRunner::class)
class AppOnlyTunnelTest {
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
}
