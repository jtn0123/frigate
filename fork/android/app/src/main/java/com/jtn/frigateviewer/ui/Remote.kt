package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.AuthException
import com.jtn.frigateviewer.data.certificateChange
import java.io.IOException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Loading state for a remote list. */
sealed interface Remote<out T> {
    data object Loading : Remote<Nothing>
    data class Ready<T>(val value: T) : Remote<T>
    data class Failed(val message: String) : Remote<Nothing>
}

fun <T, R> Remote<T>.map(transform: (T) -> R): Remote<R> = when (this) {
    Remote.Loading -> Remote.Loading
    is Remote.Ready -> Remote.Ready(transform(value))
    is Remote.Failed -> this
}

/**
 * Runs [block] as a [Remote]. When the server stops accepting this session
 * (an expired or revoked token, or a changed certificate) [onSessionLost] is
 * called with the reason to show at sign-in, or null when none is needed.
 */
suspend fun <T> loadRemote(onSessionLost: (String?) -> Unit, block: suspend () -> T): Remote<T> = try {
    Remote.Ready(block())
} catch (_: AuthException) {
    // Work cancelled with its session must not end the one after it.
    currentCoroutineContext().ensureActive()
    onSessionLost(null)
    Remote.Failed("Session expired, please sign in again")
} catch (e: IOException) {
    currentCoroutineContext().ensureActive()
    // Signing in again shows the new certificate for the user to judge.
    if (e.certificateChange() != null) onSessionLost(CERTIFICATE_CHANGED)
    Remote.Failed(describeError(e))
} catch (e: IllegalArgumentException) {
    // A response that is not what Frigate sends (including SerializationException).
    Remote.Failed(describeError(e))
}

/** A short, user-facing reason for a failed request. */
fun describeError(e: Exception): String = when {
    e.certificateChange() != null -> CERTIFICATE_CHANGED
    e is javax.net.ssl.SSLHandshakeException ->
        "Certificate not trusted. Turn on \"Self-signed certificate\" for Frigate's default port 8971."
    e is java.net.UnknownHostException -> "Server not found"
    e is java.net.ConnectException || e is java.net.SocketTimeoutException -> "Could not connect to the server"
    e is IllegalArgumentException -> "Invalid server address"
    else -> e.message ?: e.javaClass.simpleName
}

const val CERTIFICATE_CHANGED =
    "The server's certificate changed. Sign in again to check the new one before trusting it."
