package com.jtn.frigateviewer.data

import okhttp3.HttpUrl.Companion.toHttpUrl

/** What signing in came to. Failures are thrown: [AuthException] for a refused login. */
sealed interface SignInResult {
    /** Signed in, with the settings to save and start a session from. */
    data class SignedIn(val settings: ServerSettings) : SignInResult

    /**
     * The server presented a self-signed certificate that is not trusted for
     * this address. Nothing was sent; sign in again with [fingerprint] once
     * the user trusts it. [changed] is set when another one was trusted before.
     */
    data class NeedsTrust(val fingerprint: String, val changed: Boolean) : SignInResult
}

/**
 * Signs in to a Frigate server. For a self-signed server the certificate is
 * read and checked before the password is sent, and the one the user trusted
 * is the only one accepted afterwards.
 */
class SignIn(private val certificateOf: suspend (baseUrl: String) -> String = FrigateApi::serverCertificate) {
    /**
     * [previous] are the saved settings: their pin counts only for the same
     * address with self-signed on, and their preferences carry over.
     * [trustedFingerprint] is the certificate the user just accepted.
     */
    suspend fun signIn(
        previous: ServerSettings,
        url: String,
        user: String,
        password: String,
        selfSignedCert: Boolean,
        trustedFingerprint: String? = null,
    ): SignInResult {
        val base = FrigateApi.normalizeBaseUrl(url)
        val host = base.toHttpUrl().host
        if (base.startsWith("http://") && user.isNotBlank() && !isPrivateHost(host)) throw InsecureLoginException(host)
        var pin = ""
        if (selfSignedCert && base.startsWith("https://")) {
            val saved = previous.certificatePin.takeIf { previous.baseUrl == base && previous.selfSignedCert }
            val seen = trustedFingerprint ?: certificateOf(base)
            if (trustedFingerprint == null && !seen.equals(saved, ignoreCase = true)) {
                return SignInResult.NeedsTrust(seen, changed = !saved.isNullOrEmpty())
            }
            pin = seen
        }
        val probe = Session(ServerSettings(baseUrl = base, selfSignedCert = selfSignedCert, certificatePin = pin))
        val login = if (user.isBlank()) null else probe.api.login(user.trim(), password)
        val settings = previous.copy(
            baseUrl = base,
            username = user.trim(),
            token = login?.token.orEmpty(),
            tokenCookie = login?.cookieName ?: ServerSettings.DEFAULT_TOKEN_COOKIE,
            selfSignedCert = selfSignedCert,
            certificatePin = pin,
        )
        // Prove the credentials work before they are saved.
        Session(settings).api.config()
        return SignInResult.SignedIn(settings)
    }
}

/** Signing in over plain HTTP to [host], which is not on a private network, would expose the password. */
class InsecureLoginException(val host: String) :
    Exception("$host is not a local address, so plain HTTP would send your password unencrypted. Use https:// instead.")

/**
 * Whether [host] is on a private network: a private, loopback, link-local or
 * carrier-grade NAT (Tailscale) address, or a local name such as `nvr` or
 * `frigate.local`. Names are judged as written; nothing is looked up.
 */
fun isPrivateHost(host: String): Boolean {
    val name = host.lowercase().trimEnd('.')
    if (':' in name) {
        return name == "::1" || name.startsWith("fc") || name.startsWith("fd") || name.startsWith("fe80:")
    }
    ipv4(name)?.let { address -> return PRIVATE_IPV4.any { it.contains(address) } }
    return '.' !in name || LOCAL_SUFFIXES.any { name.endsWith(it) }
}

private val LOCAL_SUFFIXES = listOf(".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain")

/** Private, loopback, link-local and carrier-grade NAT (Tailscale) IPv4 networks. */
private val PRIVATE_IPV4 = listOf(
    "10.0.0.0/8",
    "127.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "100.64.0.0/10",
).map { cidr ->
    val (network, prefix) = cidr.split('/')
    Ipv4Network(ipv4(network)!!, prefix.toInt())
}

private class Ipv4Network(private val network: Long, private val prefix: Int) {
    fun contains(address: Long) = address ushr (IPV4_BITS - prefix) == network ushr (IPV4_BITS - prefix)
}

/** [text] as a 32-bit number if it is a dotted IPv4 address. */
private fun ipv4(text: String): Long? {
    val parts = text.split('.')
    if (parts.size != IPV4_OCTETS) return null
    return parts.fold(0L) { address, part ->
        val octet = part.toIntOrNull()?.takeIf { it in 0..OCTET_MAX } ?: return null
        (address shl Byte.SIZE_BITS) or octet.toLong()
    }
}

private const val IPV4_BITS = 32
private const val IPV4_OCTETS = 4
private const val OCTET_MAX = 255
