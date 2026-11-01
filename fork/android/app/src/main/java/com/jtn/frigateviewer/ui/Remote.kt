package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.Failure
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.failureOf
import com.jtn.frigateviewer.data.remote

/**
 * Runs [block] as a [Remote]. When the server stops accepting this session
 * (an expired or revoked token, or a certificate the user has to check)
 * [onSessionLost] is called with the reason to show at sign-in, or null when
 * none is needed.
 */
suspend fun <T> loadRemote(onSessionLost: (String?) -> Unit, block: suspend () -> T): Remote<T> = remote(block).also { result ->
    if (result is Remote.Failed && result.failure.endsSession) onSessionLost(result.failure.signInReason)
}

/** What to tell the user at sign-in about a session that ended with this failure. */
private val Failure.signInReason: String?
    get() = when (this) {
        Failure.CertificateChanged -> CERTIFICATE_CHANGED
        Failure.CertificateUntrusted -> CERTIFICATE_UNTRUSTED
        else -> null
    }

/** A short, user-facing reason for the failure. */
val Remote.Failed.message: String get() = failure.message

/** A short, user-facing reason for the failure. */
val Failure.message: String
    get() = when (this) {
        Failure.SessionExpired -> "Session expired, please sign in again"
        Failure.ServerNotFound -> "Server not found"
        Failure.Offline -> "Could not connect to the server"
        Failure.Timeout -> "The server did not answer in time"
        Failure.Forbidden -> FrigateApi.NOT_ALLOWED
        is Failure.Http -> if (path != null) "HTTP $code for $path" else "HTTP $code"
        Failure.BadResponse -> "The server sent a reply the app cannot read. It may be a Frigate version the app does not support."
        Failure.InvalidAddress -> "Invalid server address"
        Failure.CertificateChanged -> CERTIFICATE_CHANGED
        Failure.CertificateUntrusted -> CERTIFICATE_UNTRUSTED
        Failure.CertificateRejected ->
            "Certificate not trusted. Turn on \"Self-signed certificate\" for Frigate's default port 8971."
        is Failure.Other -> detail
    }

/** A short, user-facing reason for a failed request. */
fun describeError(e: Exception): String = failureOf(e).message

const val CERTIFICATE_CHANGED =
    "The server's certificate changed. Sign in again to check the new one before trusting it."

const val CERTIFICATE_UNTRUSTED =
    "The server's certificate is not trusted yet. Sign in again to check it before trusting it."
