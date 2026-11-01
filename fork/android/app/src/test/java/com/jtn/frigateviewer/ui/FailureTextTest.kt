package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.AuthException
import com.jtn.frigateviewer.data.Failure
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.InvalidAddressException
import com.jtn.frigateviewer.data.Remote
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/** What the user is told about each typed failure. */
class FailureTextTest {
    @Test
    fun aReplyTheAppCannotReadDoesNotBlameTheAddress() {
        val text = describeError(SerializationException("unexpected token"))
        assertNotEquals("Invalid server address", text)
        assertEquals(Failure.BadResponse.message, text)
    }

    @Test
    fun onlyAnAddressThatCannotBeParsedIsInvalid() {
        assertEquals("Invalid server address", describeError(InvalidAddressException()))
    }

    @Test
    fun eachFailureHasItsOwnText() {
        assertEquals("Session expired, please sign in again", Failure.SessionExpired.message)
        assertEquals("Server not found", Failure.ServerNotFound.message)
        assertEquals("Could not connect to the server", Failure.Offline.message)
        assertEquals("The server did not answer in time", Failure.Timeout.message)
        assertEquals(FrigateApi.NOT_ALLOWED, Failure.Forbidden.message)
        assertEquals("HTTP 500 for /api/review", Failure.Http(500, "/api/review").message)
        assertEquals("HTTP 502", Failure.Http(502, null).message)
        assertEquals(CERTIFICATE_CHANGED, Failure.CertificateChanged.message)
        assertEquals(true, Failure.CertificateRejected.message.startsWith("Certificate not trusted"))
        assertEquals("odd", Remote.Failed("odd").message)
    }

    @Test
    fun anExpiredSessionSignsOutWithoutAReason() = runBlocking {
        val sessionLost = mutableListOf<String?>()
        loadRemote({ sessionLost += it }) { throw AuthException("401") }
        assertEquals(listOf<String?>(null), sessionLost)
    }

    @Test
    fun aTimeoutKeepsTheSession() = runBlocking {
        val sessionLost = mutableListOf<String?>()
        val result = loadRemote({ sessionLost += it }) { throw java.net.SocketTimeoutException("slow") }
        assertEquals(emptyList<String?>(), sessionLost)
        assertEquals("The server did not answer in time", (result as Remote.Failed).message)
    }
}
