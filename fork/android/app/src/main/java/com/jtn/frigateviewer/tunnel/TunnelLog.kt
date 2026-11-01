package com.jtn.frigateviewer.tunnel

import androidx.compose.runtime.mutableStateListOf
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException

/**
 * What the tunnel did and why, newest last, for the Tunnel log screen and
 * its report. Each entry goes through [redact] as it is added, so neither a
 * key nor a whole address can end up here, whatever the code writing it
 * passed in. Each is also passed to [echo], the system log in the app. An
 * entry the same as the one before it within [repeatMs] is left out, as when
 * Android reports each network at once.
 */
class TunnelLog(
    private val capacity: Int = CAPACITY,
    private val clock: () -> Long = System::currentTimeMillis,
    private val echo: (String) -> Unit = {},
    private val repeatMs: Long = REPEAT_MS,
) {
    class Entry(val at: Long, val text: String)

    private val list = mutableStateListOf<Entry>()

    /**
     * A copy taken under the lock: the tunnel logs from other threads, so a
     * report or test walking the live list could fail mid-way. Reading it in
     * Compose still subscribes to changes.
     */
    val entries: List<Entry> get() = synchronized(list) { list.toList() }

    fun add(text: String) {
        val safe = redact(text)
        val added = synchronized(list) {
            val now = clock()
            val last = list.lastOrNull()
            if (last != null && last.text == safe && now - last.at < repeatMs) return@synchronized false
            list += Entry(now, safe)
            if (list.size > capacity) list.removeRange(0, list.size - capacity)
            true
        }
        if (added) echo(safe)
    }

    fun clear() {
        synchronized(list) { list.clear() }
    }

    private companion object {
        const val CAPACITY = 300
        const val REPEAT_MS = 2_000L
    }
}

/** Bytes through the tunnel and when its server last answered. */
data class TunnelStats(val sentBytes: Long, val receivedBytes: Long, val lastHandshakeMs: Long?)

private val IPV4 = Regex("""\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b""")

/** Hex groups joined by colons, which may be an IPv6 address; [ipv6] checks it is one. */
private val IPV6 = Regex("""(?<![0-9A-Za-z:.])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![0-9A-Za-z:])""")

/** A WireGuard key: 32 bytes in base64, so 43 characters and an `=`. */
private val KEY = Regex("""(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=(?![A-Za-z0-9+/=])""")

/** [text] with each key replaced and each address cut to its kind and last part, like `public …12`. */
fun redact(text: String): String = maskAddresses(KEY.replace(text, "(key hidden)"))

/** [text] with each IPv4 and IPv6 address cut to its kind and last part, like `public …12`. */
fun maskAddresses(text: String): String {
    val v4 = IPV4.replace(text) { match ->
        val octets = match.groupValues.drop(1).map { it.toIntOrNull() ?: return@replace match.value }
        if (octets.any { it > MAX_OCTET }) return@replace match.value
        "${addressKind(octets)} …${octets.last()}"
    }
    return IPV6.replace(v4) { match ->
        val address = ipv6(match.value) ?: return@replace match.value
        "${ipv6Kind(address)} IPv6 …${match.value.substringAfterLast(':').ifEmpty { "0" }}"
    }
}

/**
 * [text] as an IPv6 address, or null when it is not one. Only a full
 * address (eight groups) or one with `::` counts, so a time like `17:31:09`
 * is left alone; a literal with colons is never looked up by name.
 */
private fun ipv6(text: String): Inet6Address? {
    if ("::" !in text && text.count { it == ':' } != IPV6_COLONS) return null
    return try {
        InetAddress.getByName(text) as? Inet6Address
    } catch (_: UnknownHostException) {
        null
    }
}

private fun ipv6Kind(address: Inet6Address): String {
    val first = address.address[0].toInt() and BYTE_MASK
    return when {
        address.isAnyLocalAddress -> "any"
        address.isLoopbackAddress -> "loopback"
        address.isLinkLocalAddress -> "link-local"
        // fc00::/7, the IPv6 counterpart of a private network, and the old site-local range.
        (first and ULA_MASK) == ULA_PREFIX || address.isSiteLocalAddress -> "private"
        else -> "public"
    }
}

/** [host] cut to its kind and last part when it is an address, or to its ending when it is a name. */
fun maskHost(host: String): String {
    val bare = host.removeSurrounding("[", "]")
    return if (IPV4.matches(bare) || ipv6(bare) != null) maskAddresses(bare) else describeHost(bare)
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
        ':' in host -> ipv6(host.removeSurrounding("[", "]"))?.let { address ->
            val kind = ipv6Kind(address)
            "${if (kind == "any") "an" else "a"} $kind IPv6 address (…${host.trimEnd(']').substringAfterLast(':')})"
        } ?: "an IPv6 address"
        else -> "a hostname ending .${host.substringAfterLast('.')}"
    }
}

private fun addressKind(octets: List<Int>): String {
    val address = InetAddress.getByAddress(octets.map { it.toByte() }.toByteArray())
    return when {
        address.isAnyLocalAddress -> "any"
        address.isSiteLocalAddress -> "private"
        // 100.64.0.0/10, which carriers and ISPs put many customers behind.
        octets[0] == CGNAT_FIRST && octets[1] in CGNAT_SECOND -> "carrier-NAT"
        address.isLoopbackAddress -> "loopback"
        address.isLinkLocalAddress -> "link-local"
        else -> "public"
    }
}

private const val IPV4_PARTS = 4
private const val MAX_OCTET = 255
private const val IPV6_COLONS = 7
private const val BYTE_MASK = 0xff
private const val ULA_MASK = 0xfe
private const val ULA_PREFIX = 0xfc
private const val CGNAT_FIRST = 100
private val CGNAT_SECOND = 64..127
