package com.jtn.frigateviewer.data

import java.io.IOException
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

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

    /**
     * The password would go over plain HTTP to [host], a carrier-grade NAT
     * address: Tailscale's, whose own encryption makes that safe, or a mobile
     * carrier's, where it would not be. Nothing was sent; sign in again with
     * the user's consent once they confirm.
     */
    data class NeedsHttpConsent(val host: String) : SignInResult
}

/**
 * Signs in to a Frigate server. For a self-signed server the certificate is
 * checked before the password is sent, and the one the user trusted is the
 * only one accepted afterwards. Every step goes over the same pooled
 * connection, so signing in costs one TLS handshake, or two when the
 * certificate has to be read and shown first.
 */
class SignIn(private val certificateOf: suspend (baseUrl: String) -> String = FrigateApi::serverCertificate) {
    /**
     * [previous] are the saved settings: their pin counts only for the same
     * address with self-signed on, and their preferences carry over.
     * [trustedFingerprint] is the certificate the user just accepted, and
     * [httpConsent] that they agreed to send the password over plain HTTP to
     * a carrier-grade NAT address.
     */
    suspend fun signIn(
        previous: ServerSettings,
        url: String,
        user: String,
        password: String,
        selfSignedCert: Boolean,
        trustedFingerprint: String? = null,
        httpConsent: Boolean = false,
    ): SignInResult {
        val base = FrigateApi.normalizeBaseUrl(url)
        // The parsed scheme, not the text, so no spelling of it skips a check.
        val parsed = base.toHttpUrlOrNull() ?: throw InvalidAddressException()
        val host = parsed.host
        plainHttpCheck(parsed.isHttps, host, user, httpConsent)?.let { return it }
        var pin = ""
        if (selfSignedCert && parsed.isHttps) {
            val saved = previous.certificatePin.takeIf { previous.baseUrl == base && previous.selfSignedCert && it.isNotEmpty() }
            // None trusted yet: read it, sending nothing, for the user to decide on.
            pin = trustedFingerprint ?: saved ?: return SignInResult.NeedsTrust(certificateOf(base), changed = false)
        }
        return try {
            signIn(previous, ServerSettings(baseUrl = base, selfSignedCert = selfSignedCert, certificatePin = pin), user, password)
        } catch (e: IOException) {
            // The TLS handshake fails before anything is sent, the password included.
            val change = e.certificateChange() ?: throw e
            SignInResult.NeedsTrust(change.actual, changed = true)
        }
    }

    /** Logs in to the server [probe] names, trusting the certificate it pins, and checks the result works. */
    private suspend fun signIn(previous: ServerSettings, probe: ServerSettings, user: String, password: String): SignInResult {
        val login = if (user.isBlank()) null else Session(probe).api.login(user.trim(), password)
        val settings = previous.copy(
            baseUrl = probe.baseUrl,
            username = user.trim(),
            token = login?.token.orEmpty(),
            tokenCookie = login?.cookieName ?: ServerSettings.DEFAULT_TOKEN_COOKIE,
            selfSignedCert = probe.selfSignedCert,
            certificatePin = probe.certificatePin,
            signedOut = false,
        )
        // Prove the credentials work before they are saved.
        Session(settings).api.config()
        return SignInResult.SignedIn(settings)
    }
}

/**
 * Whether a password for [user] may go to [host]: always over HTTPS or to a
 * private network, after the user's [consent] to a carrier-grade NAT address
 * (null when it may, else the consent to ask for), and never to a public one.
 */
internal fun plainHttpCheck(https: Boolean, host: String, user: String, consent: Boolean): SignInResult.NeedsHttpConsent? {
    if (https || user.isBlank() || isPrivateHost(host)) return null
    if (!isSharedAddress(host)) throw InsecureLoginException(host)
    return if (consent) null else SignInResult.NeedsHttpConsent(host)
}

/** Signing in over plain HTTP to [host], which is not on a private network, would expose the password. */
class InsecureLoginException(val host: String) :
    Exception("$host is not a local address, so plain HTTP would send your password unencrypted. Use https:// instead.")

/**
 * Whether [host] is on a private network: a private, loopback or link-local
 * address, or a local name such as `nvr` or `frigate.local`. Names are judged
 * as written; nothing is looked up. Carrier-grade NAT addresses are not
 * counted (see [isSharedAddress]).
 */
fun isPrivateHost(host: String): Boolean {
    val name = host.lowercase().trimEnd('.')
    if (':' in name) {
        return name == "::1" || name.startsWith("fc") || name.startsWith("fd") || name.startsWith("fe80:")
    }
    ipv4(name)?.let { address -> return PRIVATE_IPV4.any { it.contains(address) } }
    return '.' !in name || LOCAL_SUFFIXES.any { name.endsWith(it) }
}

/**
 * Whether [host] is in the carrier-grade NAT range, 100.64.0.0/10. Tailscale
 * gives its devices these addresses, but so do mobile carriers for their
 * customers, so plain HTTP to one may or may not leave the user's own network.
 */
fun isSharedAddress(host: String): Boolean = ipv4(host.trimEnd('.'))?.let(SHARED_IPV4::contains) ?: false

private val LOCAL_SUFFIXES = listOf(".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain")

/** Private, loopback and link-local IPv4 networks. */
private val PRIVATE_IPV4 = listOf(
    "10.0.0.0/8",
    "127.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
).map(::ipv4Network)

/** Carrier-grade NAT, as used by Tailscale and by mobile carriers. */
private val SHARED_IPV4 = ipv4Network("100.64.0.0/10")

private fun ipv4Network(cidr: String): Ipv4Network {
    val (network, prefix) = cidr.split('/')
    return Ipv4Network(ipv4(network)!!, prefix.toInt())
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
