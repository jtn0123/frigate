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
    val (parsed, unreadable) = read(text)
    val problem = when {
        parsed == null -> unreadable ?: NOT_WIREGUARD
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

/**
 * The VPN servers the file dials, for the log and report: an address as its
 * kind and last part, and a name only by its ending, since a home's dynamic
 * DNS name gives its address away. Null when the file cannot be read.
 */
fun maskedEndpoints(text: String): String? = parse(text)?.peers?.mapNotNull { it.endpoint.orElse(null) }
    ?.joinToString(", ") { "${maskHost(it.host)}, UDP port ${it.port}" }?.ifEmpty { null }

/** The first VPN server's host and port; null when the file cannot be read or names none. */
fun tunnelServer(text: String): Pair<String, Int>? =
    parse(text)?.peers?.firstNotNullOfOrNull { it.endpoint.orElse(null) }?.let { it.host to it.port }

private fun parse(text: String): Config? = read(text).first

/** The file read as WireGuard's, or null with what is wrong with it. */
private fun read(text: String): Pair<Config?, String?> = try {
    Config.parse(usable(text).byteInputStream()) to null
} catch (e: BadConfigException) {
    null to describe(e)
} catch (_: IOException) {
    null to NOT_WIREGUARD
}

/**
 * [text] without what WireGuard's parser rejects but a tunnel does not need:
 * the byte order mark Windows editors put first, and wg-quick's settings for
 * desktop scripts and routing tables, which an Android VPN has no use for.
 */
private fun usable(text: String): String = text.removePrefix(BYTE_ORDER_MARK).lineSequence()
    .filterNot { line ->
        val setting = line.substringBefore('#')
        '=' in setting && setting.substringBefore('=').trim().lowercase() in WG_QUICK_ONLY
    }
    .joinToString("\n")

/**
 * What is wrong with the file, in words. The parser's text is quoted only
 * when it is a section or setting name: for other errors it can be a whole
 * line or value, which may be the private key.
 */
private fun describe(e: BadConfigException): String {
    val section = sectionName(e.section)
    val setting = e.location.getName()
    return when (e.reason) {
        BadConfigException.Reason.MISSING_SECTION -> "The file has no [Interface] section, so it is not a whole WireGuard configuration."
        BadConfigException.Reason.UNKNOWN_SECTION -> quoted(e, SECTION)
            ?.let { "The file has a section WireGuard does not know, $it. Only [Interface] and [Peer] are allowed." }
            ?: NOT_WIREGUARD
        BadConfigException.Reason.UNKNOWN_ATTRIBUTE ->
            "The file's $section has a setting WireGuard does not know${quoted(e, NAME)?.let { ": $it" }.orEmpty()}."
        BadConfigException.Reason.MISSING_ATTRIBUTE -> "The file's $section has no $setting."
        BadConfigException.Reason.INVALID_KEY -> "The file's $section $setting is not a valid WireGuard key."
        BadConfigException.Reason.SYNTAX_ERROR -> "A line in the file's $section is not a setting of the form Name = value."
        else -> if (e.location == BadConfigException.Location.TOP_LEVEL) NOT_WIREGUARD else "The file's $section $setting is not valid."
    }
}

private fun sectionName(section: BadConfigException.Section): String = when (section) {
    BadConfigException.Section.INTERFACE -> "[Interface]"
    BadConfigException.Section.PEER -> "[Peer]"
    else -> "file"
}

/** The parser's text when it is only a name of the [shape] given, or null. */
private fun quoted(e: BadConfigException, shape: Regex): String? = e.text?.toString()?.trim()?.takeIf { shape.matches(it) }

private const val NOT_WIREGUARD = "This is not a WireGuard configuration file."
private const val BYTE_ORDER_MARK = "\uFEFF"
private val WG_QUICK_ONLY = setOf("preup", "postup", "predown", "postdown", "table", "saveconfig")
private val SECTION = Regex("""\[[A-Za-z]{1,24}]""")
private val NAME = Regex("""[A-Za-z]{1,32}""")
