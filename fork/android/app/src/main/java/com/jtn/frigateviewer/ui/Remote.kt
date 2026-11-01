package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.Failure
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.failureOf
import com.jtn.frigateviewer.data.remote

/**
 * Runs [block] as a [Remote]. When the server stops accepting this session
 * (an expired or revoked token, or a certificate the user has to check)
 * [onSessionLost] is called with the reason to show at sign-in, or null when
 * none is needed.
 */
suspend fun <T> loadRemote(onSessionLost: (UiText?) -> Unit, block: suspend () -> T): Remote<T> = remote(block).also { result ->
    if (result is Remote.Failed && result.failure.endsSession) onSessionLost(result.failure.signInReason)
}

/** What to tell the user at sign-in about a session that ended with this failure. */
private val Failure.signInReason: UiText?
    get() = when (this) {
        Failure.CertificateChanged, Failure.CertificateUntrusted -> text
        else -> null
    }

/** A short, user-facing reason for the failure. */
val Remote.Failed.text: UiText get() = failure.text

/** A short, user-facing reason for the failure. */
val Failure.text: UiText
    get() = when (this) {
        Failure.SessionExpired -> uiText(R.string.failure_session_expired)
        Failure.ServerNotFound -> uiText(R.string.failure_server_not_found)
        Failure.Offline -> uiText(R.string.failure_offline)
        Failure.Timeout -> uiText(R.string.failure_timeout)
        Failure.Forbidden -> uiText(R.string.failure_forbidden)
        is Failure.Http -> if (path !=
            null
        ) {
            uiText(R.string.failure_http_path, code.toString(), path)
        } else {
            uiText(R.string.failure_http, code)
        }
        Failure.BadResponse -> uiText(R.string.failure_bad_response)
        Failure.InvalidAddress -> uiText(R.string.failure_invalid_address)
        Failure.CertificateChanged -> uiText(R.string.failure_certificate_changed)
        Failure.CertificateUntrusted -> uiText(R.string.failure_certificate_untrusted)
        Failure.CertificateRejected -> uiText(R.string.failure_certificate_rejected)
        is Failure.Other -> UiText.Plain(detail)
    }

/** A short, user-facing reason for a failed request. */
fun describeError(e: Exception): UiText = failureOf(e).text
