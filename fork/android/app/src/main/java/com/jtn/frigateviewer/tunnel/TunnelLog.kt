package com.jtn.frigateviewer.tunnel

import androidx.compose.runtime.mutableStateListOf
import java.net.InetAddress

/**
 * What the tunnel did and why, newest last, for the Tunnel log screen and
 * its report. Entries never hold the private key, and addresses in them are
 * masked by the code that writes them. Each is also passed to [echo], the
 * system log in the app.
 */
class TunnelLog(
    private val capacity: Int = CAPACITY,
    private val clock: () -> Long = System::currentTimeMillis,
    private val echo: (String) -> Unit = {},
) {
    class Entry(val at: Long, val text: String)

    private val list = mutableStateListOf<Entry>()

    val entries: List<Entry> get() = list

    fun add(text: String) {
        synchronized(list) {
            list += Entry(clock(), text)
            if (list.size > capacity) list.removeRange(0, list.size - capacity)
        }
        echo(text)
    }

    fun clear() {
        synchronized(list) { list.clear() }
    }

    private companion object {
        const val CAPACITY = 300
    }
}

/** Bytes through the tunnel and when its server last answered. */
data class TunnelStats(val sentBytes: Long, val receivedBytes: Long, val lastHandshakeMs: Long?)

private val IPV4 = Regex("""\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b""")

/** [text] with each IPv4 address cut to its kind and last number, like `public …12`. */
fun maskAddresses(text: String): String = IPV4.replace(text) { match ->
    val octets = match.groupValues.drop(1).map { it.toIntOrNull() ?: return@replace match.value }
    "${addressKind(octets)} …${octets.last()}"
}

/** What kind of address [host] is, and so whether it can be reached from the internet. */
fun describeHost(host: String): String {
    val octets = IPV4.matchEntire(host)?.groupValues?.drop(1)?.mapNotNull { it.toIntOrNull() }
    return when {
        octets != null && octets.size == IPV4_PARTS -> when (val kind = addressKind(octets)) {
            "public" -> "a public IPv4 address (…${octets.last()})"
            "private" -> "a private IPv4 address (…${octets.last()}), only reachable inside that network"
            "carrier-NAT" -> "a carrier-grade NAT address (…${octets.last()}), not reachable from the internet"
            else -> "a $kind address (…${octets.last()})"
        }
        ':' in host -> "an IPv6 address"
        else -> "a hostname ending .${host.substringAfterLast('.')}"
    }
}

private fun addressKind(octets: List<Int>): String {
    val address = InetAddress.getByAddress(octets.map { it.toByte() }.toByteArray())
    return when {
        address.isSiteLocalAddress -> "private"
        // 100.64.0.0/10, which carriers and ISPs put many customers behind.
        octets[0] == CGNAT_FIRST && octets[1] in CGNAT_SECOND -> "carrier-NAT"
        address.isLoopbackAddress -> "loopback"
        address.isLinkLocalAddress -> "link-local"
        else -> "public"
    }
}

private const val IPV4_PARTS = 4
private const val CGNAT_FIRST = 100
private val CGNAT_SECOND = 64..127
