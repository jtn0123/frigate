package com.jtn.frigateviewer.data

import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection.HTTP_FORBIDDEN
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Loading state for a remote list. */
sealed interface Remote<out T> {
    data object Loading : Remote<Nothing>
    data class Ready<T>(val value: T) : Remote<T>
    data class Failed(val failure: Failure) : Remote<Nothing> {
        /** A failure the app describes itself, such as there being no session to ask. */
        constructor(detail: String) : this(Failure.Other(detail))
    }
}

fun <T, R> Remote<T>.map(transform: (T) -> R): Remote<R> = when (this) {
    Remote.Loading -> Remote.Loading
    is Remote.Ready -> Remote.Ready(transform(value))
    is Remote.Failed -> this
}

/** Why a request failed, so callers can tell the cases apart and the UI can say what happened. */
sealed interface Failure {
    /** The server no longer accepts the session's token (HTTP 401). */
    data object SessionExpired : Failure

    /** The server's name could not be looked up. */
    data object ServerNotFound : Failure

    /** Nothing answered at the server's address. */
    data object Offline : Failure

    /** The server did not answer in time. */
    data object Timeout : Failure

    /** This account may not see or do this (HTTP 403); the session stays good. */
    data object Forbidden : Failure

    /** Another unsuccessful status [code], for the request to [path]. */
    data class Http(val code: Int, val path: String?) : Failure

    /** The reply is not what Frigate sends, as after a server upgrade changed it. */
    data object BadResponse : Failure

    /** The address typed at sign-in is not one. */
    data object InvalidAddress : Failure

    /** The server's self-signed certificate differs from the one the user trusted. */
    data object CertificateChanged : Failure

    /** The server's certificate is not one the phone trusts, and self-signed is off. */
    data object CertificateRejected : Failure

    /** Anything else, with what is known of it. */
    data class Other(val detail: String) : Failure

    /** Whether the session cannot go on: the user has to sign in again. */
    val endsSession: Boolean get() = this == SessionExpired || this == CertificateChanged
}

/** The sign-in address cannot be parsed. */
class InvalidAddressException : IllegalArgumentException("Invalid server address")

/** What [e], thrown by a request, means. */
fun failureOf(e: Exception): Failure = certificateFailure(e) ?: when {
    e is AuthException -> Failure.SessionExpired
    e is UnknownHostException -> Failure.ServerNotFound
    e is ConnectException -> Failure.Offline
    e is SocketTimeoutException -> Failure.Timeout
    e is HttpException && e.code == HTTP_FORBIDDEN -> Failure.Forbidden
    e is HttpException -> Failure.Http(e.code, e.path)
    e is InvalidAddressException -> Failure.InvalidAddress
    // Includes SerializationException: a reply that is not what Frigate sends.
    e is IllegalArgumentException -> Failure.BadResponse
    else -> Failure.Other(e.message ?: e.javaClass.simpleName)
}

/** The certificate problem [e] comes from, if it is one. */
private fun certificateFailure(e: Exception): Failure? = when {
    e.certificateChange() != null -> Failure.CertificateChanged
    e is SSLHandshakeException -> Failure.CertificateRejected
    else -> null
}

/**
 * Runs [block] as a [Remote], with a request's failure as [Remote.Failed].
 * Work cancelled meanwhile is not reported as failed: its caller is gone, and
 * a failure it saw must not end the session after it.
 */
suspend fun <T> remote(block: suspend () -> T): Remote<T> = try {
    Remote.Ready(block())
} catch (e: IOException) {
    currentCoroutineContext().ensureActive()
    Remote.Failed(failureOf(e))
} catch (e: IllegalArgumentException) {
    Remote.Failed(failureOf(e))
}
