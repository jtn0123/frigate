package com.jtn.frigateviewer.data

import android.annotation.SuppressLint
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

/**
 * The session's JWT. It is sent as Frigate's auth cookie rather than a Bearer
 * header because Frigate only renews cookie tokens: when one nears expiry the
 * response carries a fresh cookie, which replaces this one and is passed to
 * [onRenewed] so it can be saved.
 */
class AuthToken(val cookieName: String, initial: String, private val onRenewed: (String) -> Unit = {}) {
    private val value = AtomicReference(initial)

    val current: String get() = value.get()

    internal fun renew(token: String) {
        if (token.isNotEmpty() && value.getAndSet(token) != token) onRenewed(token)
    }
}

/**
 * The value of cookie [name] in a `Set-Cookie` header, or null for another
 * cookie or a deletion, which Frigate sends as `name=""`.
 */
internal fun cookieValue(setCookie: String, name: String): String? {
    val pair = setCookie.substringBefore(';').trim()
    if (pair.substringBefore('=') != name) return null
    return pair.substringAfter('=', "").removeSurrounding("\"").takeIf { it.isNotEmpty() }
}

/**
 * Builds the single HTTP client shared by the API, image loading and video
 * playback, so every request carries the same credentials. A [pin] limits
 * TLS to one self-signed certificate; without one the system trust store applies.
 */
fun buildHttpClient(auth: AuthToken?, pin: CertificatePin?): OkHttpClient {
    val builder = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val token = auth?.current.orEmpty()
            val request = chain.request().newBuilder().apply {
                if (auth != null && token.isNotEmpty()) header("Cookie", "${auth.cookieName}=$token")
                // Frigate's CSRF check only needs the header to be present.
                if (chain.request().method != "GET") header("X-CSRF-TOKEN", "1")
            }.build()
            val response = chain.proceed(request)
            if (auth != null) {
                response.headers("Set-Cookie").firstNotNullOfOrNull { cookieValue(it, auth.cookieName) }?.let(auth::renew)
            }
            response
        }
    if (pin != null) builder.trustOnly(pin)
    return builder.build()
}

/** SHA-256 of the certificate, as colon-separated uppercase hex like browsers show it. */
fun certificateFingerprint(certificate: X509Certificate): String =
    MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString(":") { "%02X".format(it) }

/** The server presented a different certificate from the one the user accepted. */
class CertificateChangedException(val expected: String, val actual: String) :
    CertificateException("The server's certificate changed")

/**
 * The [CertificateChangedException] behind a failed connection, if that is why
 * it failed. OkHttp reports the last route it tried and attaches earlier
 * routes' failures as suppressed, so those are searched too.
 */
fun Throwable.certificateChange(depth: Int = 0): CertificateChangedException? = when {
    this is CertificateChangedException -> this
    depth > MAX_CAUSE_DEPTH -> null
    else -> (listOfNotNull(cause) + suppressed).firstNotNullOfOrNull { it.certificateChange(depth + 1) }
}

/** How deep [certificateChange] looks; causes do not nest further than this in practice. */
private const val MAX_CAUSE_DEPTH = 8

/**
 * Trust for a server with a self-signed certificate, such as Frigate's port
 * 8971: only the certificate with [fingerprint] is accepted. With no
 * fingerprint yet, the first certificate seen is accepted and pinned (trust
 * on first use), and [onPinned] receives it so it can be saved.
 */
class CertificatePin(fingerprint: String?, private val onPinned: (String) -> Unit = {}) {
    private val pinned = AtomicReference(fingerprint?.takeIf { it.isNotEmpty() })

    val fingerprint: String? get() = pinned.get()

    internal fun check(certificate: X509Certificate) {
        val actual = certificateFingerprint(certificate)
        val expected = pinned.get()
        when {
            expected == null -> if (pinned.compareAndSet(null, actual)) onPinned(actual) else check(certificate)
            !expected.equals(actual, ignoreCase = true) -> throw CertificateChangedException(expected, actual)
        }
    }
}

/**
 * Accepts exactly the pinned certificate. The hostname is not checked: a
 * self-signed certificate rarely names the address it is reached at, and the
 * pin already identifies the server more strictly than a hostname would.
 */
@SuppressLint("CustomX509TrustManager")
private fun OkHttpClient.Builder.trustOnly(pin: CertificatePin) {
    val trustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
            throw CertificateException("Client certificates are not supported")

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            pin.check(chain?.firstOrNull() ?: throw CertificateException("The server sent no certificate"))
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
    val context = SSLContext.getInstance("TLS").apply {
        init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
    }
    sslSocketFactory(context.socketFactory, trustManager)
    hostnameVerifier { _, _ -> true }
}
