package com.jtn.frigateviewer.tunnel

import android.os.Process
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * A plain-text account of the tunnel to copy or share when it does not
 * work: its settings as kinds of address rather than the addresses, its
 * status and traffic, the log, and WireGuard's own lines. Never the keys:
 * the whole text goes through [redact] last, so nothing key- or
 * address-shaped gets out whatever a line was built from.
 */
fun tunnelReport(
    remote: RemoteAccess,
    serverUrl: String,
    about: List<String>,
    libraryLines: List<String>,
    now: Long = System.currentTimeMillis(),
): String = redact(
    buildString {
        reportBody(remote, serverUrl, about, libraryLines, now)
    },
)

private fun StringBuilder.reportBody(
    remote: RemoteAccess,
    serverUrl: String,
    about: List<String>,
    libraryLines: List<String>,
    now: Long,
) {
    val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
    appendLine("Frigate tunnel report, ${time.format(Date(now))}")
    about.forEach(::appendLine)
    appendLine()
    appendLine("Status: ${describeStatus(remote.status)}")
    val tunnel = remote.tunnel
    appendLine(
        "Tunnel: ${if (tunnel == null) "none imported" else "\"${redact(tunnel.name)}\", turned ${if (tunnel.enabled) "on" else "off"}"}",
    )
    // As last asked: asking again for the report would turn another app's VPN off.
    val permission = when (remote.permitted) {
        true -> "allowed"
        false -> "not allowed"
        null -> "not asked yet, since the tunnel has not been needed"
    }
    appendLine("Android VPN permission: $permission")
    appendLine("Another app's VPN: ${if (remote.otherVpnOn) "on" else "off"}")
    appendLine("Frigate server: ${describeServer(serverUrl)}")
    tunnel?.let { tunnelSummary(it.config).forEach(::appendLine) }
    remote.stats?.let { stats ->
        val handshake = stats.lastHandshakeMs?.let { "${(now - it) / MS_PER_S} s ago" } ?: "never"
        appendLine("Traffic: sent ${stats.sentBytes} bytes, received ${stats.receivedBytes} bytes, last handshake $handshake")
    }
    appendLine()
    appendLine("Log:")
    val clock = SimpleDateFormat("HH:mm:ss", Locale.US)
    remote.log.entries.forEach { appendLine("${clock.format(Date(it.at))}  ${it.text}") }
    if (libraryLines.isNotEmpty()) {
        appendLine()
        appendLine("WireGuard:")
        libraryLines.forEach(::appendLine)
    }
}

/** [status] for the report: a failure in words, the others by name. */
private fun describeStatus(status: TunnelStatus): String = when {
    status is TunnelStatus.Failed && status.noAnswer -> "Failed, the VPN server never answered. ${status.message}"
    status is TunnelStatus.Failed -> "Failed. ${status.message}"
    else -> "$status"
}

/** What one AllowedIPs entry sends through the tunnel: everything, for the usual default routes. */
internal fun describeRoute(route: String): String = when (route) {
    "0.0.0.0/0" -> "all IPv4 traffic"
    "::/0", "0:0:0:0:0:0:0:0/0" -> "all IPv6 traffic"
    else -> maskAddresses(route)
}

/** The server address as a kind of address, scheme and port, without the address. */
fun describeServer(url: String): String {
    val parsed = url.toHttpUrlOrNull() ?: return "not set"
    return "${parsed.scheme}, port ${parsed.port}, ${describeHost(parsed.host)}"
}

/** What the tunnel file sets up, with each address given as its kind. */
private fun tunnelSummary(config: String): List<String> {
    val parsed = try {
        appOnlyTunnel(config, "")
    } catch (e: TunnelConfigException) {
        return listOf("Tunnel file: not usable (${e.message})")
    }
    val iface = parsed.`interface`
    return buildList {
        add("Tunnel address: ${iface.addresses.joinToString { maskAddresses(it.toString()) }}")
        add(
            "Tunnel DNS: ${if (iface.dnsServers.isEmpty()) {
                "none"
            } else {
                iface.dnsServers.joinToString {
                    maskAddresses(it.hostAddress.orEmpty())
                }
            }}",
        )
        iface.mtu.ifPresent { add("MTU: $it") }
        parsed.peers.forEachIndexed { index, peer ->
            val endpoint = peer.endpoint.orElse(null)
            add(
                "VPN server ${index + 1}: " + (endpoint?.let { "${describeHost(it.host)}, UDP port ${it.port}" } ?: "no Endpoint"),
            )
            add("  Routes through the tunnel (AllowedIPs): ${peer.allowedIps.joinToString { describeRoute(it.toString()) }}")
            add("  Keepalive: ${peer.persistentKeepalive.map { "$it s" }.orElse("off")}")
            add("  Preshared key: ${if (peer.preSharedKey.isPresent) "set" else "none"}")
        }
    }
}

/**
 * WireGuard's own recent lines from this app's log, which an app may read for
 * itself, without the per-worker start and stop noise and with addresses masked.
 */
suspend fun wireGuardLines(limit: Int = LIBRARY_LINES): List<String> = withContext(Dispatchers.IO) {
    val command = listOf(
        "logcat", "-d", "-v", "time", "--pid=${Process.myPid()}", "-t", "$LOG_SCAN",
        "WireGuard/GoBackend/frigate:V", "WireGuard/GoBackend:V", "*:S",
    )
    try {
        val process = ProcessBuilder(command).redirectErrorStream(true).start()
        val lines = process.inputStream.bufferedReader().use { it.readLines() }
        process.waitFor()
        libraryReportLines(lines, limit)
    } catch (e: IOException) {
        listOf("Could not read WireGuard's log: ${e::class.simpleName}")
    }
}

/**
 * WireGuard's lines as the report shows them: without worker noise, with
 * keys and addresses cut, and with the errors known to be harmless saying so.
 */
internal fun libraryReportLines(lines: List<String>, limit: Int = LIBRARY_LINES): List<String> = lines
    .filter { "WireGuard" in it && !WORKER.containsMatchIn(it) }
    .map { line -> redact(line) + if ("UAPIOpen" in line) UAPI_HARMLESS else "" }
    .takeLast(limit)

/**
 * WireGuard's library tries to open a control socket in the official
 * WireGuard app's folder, which this app may not write to. The tunnel does
 * not use it, so the error changes nothing.
 */
private const val UAPI_HARMLESS = "  (harmless: a control socket for the official WireGuard app, which this app does not use)"

private val WORKER = Regex("""worker \d+ - (started|stopped)""")
private const val LIBRARY_LINES = 120
private const val LOG_SCAN = 2_000
private const val MS_PER_S = 1_000L
