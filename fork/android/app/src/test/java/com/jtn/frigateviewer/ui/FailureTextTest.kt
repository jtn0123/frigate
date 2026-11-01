package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.AuthException
import com.jtn.frigateviewer.data.CertificateUntrustedException
import com.jtn.frigateviewer.data.Failure
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.InvalidAddressException
import com.jtn.frigateviewer.data.Remote
import javax.net.ssl.SSLHandshakeException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** What the user is told about each typed failure. */
@RunWith(RobolectricTestRunner::class)
class FailureTextTest {
    @Test
    fun aReplyTheAppCannotReadDoesNotBlameTheAddress() {
        val text = describeError(SerializationException("unexpected token")).english()
        assertNotEquals("Invalid server address", text)
        assertEquals(Failure.BadResponse.text.english(), text)
    }

    @Test
    fun onlyAnAddressThatCannotBeParsedIsInvalid() {
        assertEquals("Invalid server address", describeError(InvalidAddressException()).english())
    }

    @Test
    fun eachFailureHasItsOwnText() {
        assertEquals("Session expired, please sign in again", Failure.SessionExpired.text.english())
        assertEquals("Server not found", Failure.ServerNotFound.text.english())
        assertEquals("Could not connect to the server", Failure.Offline.text.english())
        assertEquals("The server did not answer in time", Failure.Timeout.text.english())
        assertEquals("The data layer's own 403 text reads the same", FrigateApi.NOT_ALLOWED, Failure.Forbidden.text.english())
        assertEquals("HTTP 500 for /api/review", Failure.Http(500, "/api/review").text.english())
        assertEquals("HTTP 502", Failure.Http(502, null).text.english())
        assertEquals(
            "The server's certificate changed. Sign in again to check the new one before trusting it.",
            Failure.CertificateChanged.text.english(),
        )
        assertEquals(
            "The server's certificate is not trusted yet. Sign in again to check it before trusting it.",
            Failure.CertificateUntrusted.text.english(),
        )
        assertEquals(true, Failure.CertificateRejected.text.english().startsWith("Certificate not trusted"))
        assertEquals("odd", Remote.Failed("odd").text.english())
    }

    @Test
    fun aCertificateNeverTrustedSignsOutToShowIt() = runBlocking {
        val sessionLost = mutableListOf<UiText?>()
        val failure = SSLHandshakeException("handshake").apply { initCause(CertificateUntrustedException("AA")) }

        val result = loadRemote({ sessionLost += it }) { throw failure }

        assertEquals(listOf<UiText?>(Failure.CertificateUntrusted.text), sessionLost)
        assertEquals(Remote.Failed(Failure.CertificateUntrusted), result)
    }

    @Test
    fun anExpiredSessionSignsOutWithoutAReason() = runBlocking {
        val sessionLost = mutableListOf<UiText?>()
        loadRemote({ sessionLost += it }) { throw AuthException("401") }
        assertEquals(listOf<UiText?>(null), sessionLost)
    }

    @Test
    fun aTimeoutKeepsTheSession() = runBlocking {
        val sessionLost = mutableListOf<UiText?>()
        val result = loadRemote({ sessionLost += it }) { throw java.net.SocketTimeoutException("slow") }
        assertEquals(emptyList<UiText?>(), sessionLost)
        assertEquals("The server did not answer in time", (result as Remote.Failed).text.english())
    }
}
