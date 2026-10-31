package com.jtn.frigateviewer.tunnel

import com.wireguard.config.BadConfigException
import com.wireguard.config.Config
import com.wireguard.config.Interface
import java.io.IOException

/** The largest file accepted; a WireGuard configuration is a few hundred bytes. */
const val TUNNEL_FILE_MAX_BYTES = 64 * 1024

/**
 * Reads a WireGuard (wg-quick) file, such as the one UniFi exports for a VPN
 * client, and limits its tunnel to [packageName]: only this app's traffic goes
 * through it, whatever applications the file names.
 */
fun appOnlyTunnel(text: String, packageName: String): Config {
    val parsed = parse(text)
    val problem = when {
        parsed == null -> "This is not a WireGuard configuration file."
        parsed.peers.isEmpty() -> "The file has no server ([Peer]) to connect to."
        parsed.peers.any { !it.endpoint.isPresent } -> "The file's server has no Endpoint address."
        else -> null
    }
    if (parsed == null || problem != null) throw TunnelConfigException(problem.orEmpty())

    val original = parsed.`interface`
    val appOnly = Interface.Builder().apply {
        addAddresses(original.addresses)
        addDnsServers(original.dnsServers)
        addDnsSearchDomains(original.dnsSearchDomains)
        setKeyPair(original.keyPair)
        original.listenPort.ifPresent(::setListenPort)
        original.mtu.ifPresent(::setMtu)
        includeApplication(packageName)
    }.build()
    return Config.Builder().setInterface(appOnly).addPeers(parsed.peers).build()
}

/** The VPN server the file dials, as `host:port`; null when the file cannot be read. */
fun tunnelEndpoint(text: String): String? =
    parse(text)?.peers?.mapNotNull { peer -> peer.endpoint.orElse(null)?.toString() }?.joinToString(", ")?.ifEmpty { null }

/** The first VPN server's host and port; null when the file cannot be read or names none. */
fun tunnelServer(text: String): Pair<String, Int>? =
    parse(text)?.peers?.firstNotNullOfOrNull { it.endpoint.orElse(null) }?.let { it.host to it.port }

private fun parse(text: String): Config? = try {
    Config.parse(text.byteInputStream())
} catch (_: BadConfigException) {
    null
} catch (_: IOException) {
    null
}
