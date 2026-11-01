package com.jtn.frigateviewer.data

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Request failures become typed [Failure]s. */
class ResultTest {
    @get:Rule val serverRule = MockWebServerRule()
    private val server: MockWebServer get() = serverRule.server

    private fun api() = FrigateApi(buildHttpClient(null, pin = null), server.url("/").toString())

    @Test
    fun eachKindOfFailureIsToldApart() {
        assertEquals(Failure.SessionExpired, failureOf(AuthException("401")))
        assertEquals(Failure.ServerNotFound, failureOf(UnknownHostException("nvr")))
        assertEquals(Failure.Offline, failureOf(ConnectException("refused")))
        assertEquals(Failure.Timeout, failureOf(SocketTimeoutException("slow")))
        assertEquals(Failure.Forbidden, failureOf(HttpException(403, FrigateApi.NOT_ALLOWED)))
        assertEquals(Failure.Http(500, "/api/review"), failureOf(HttpException(500, "HTTP 500", "/api/review")))
        assertEquals(Failure.CertificateRejected, failureOf(SSLHandshakeException("untrusted")))
        assertEquals(Failure.InvalidAddress, failureOf(InvalidAddressException()))
        assertEquals(Failure.Other("odd"), failureOf(IOException("odd")))
        assertEquals(Failure.Other("IOException"), failureOf(IOException()))
    }

    @Test
    fun aReplyTheAppCannotReadIsABadResponseNotABadAddress() {
        assertEquals(Failure.BadResponse, failureOf(SerializationException("unexpected token")))
        assertEquals(Failure.BadResponse, failureOf(IllegalArgumentException("not JSON")))
    }

    @Test
    fun certificateProblemsAreFoundBehindTheHandshakeFailure() {
        val changed = SSLHandshakeException("handshake").apply { initCause(CertificateChangedException("AA", "BB")) }
        assertEquals(Failure.CertificateChanged, failureOf(changed))
    }

    @Test
    fun onlyAnExpiredSessionOrACertificateToCheckEndTheSession() {
        assertTrue(Failure.SessionExpired.endsSession)
        assertTrue(Failure.CertificateChanged.endsSession)
        listOf(Failure.Offline, Failure.Forbidden, Failure.BadResponse, Failure.CertificateRejected, Failure.Http(500, null))
            .forEach { assertTrue("$it", !it.endsSession) }
    }

    @Test
    fun aFailedRequestIsTyped() = runBlocking {
        server.enqueue(MockResponse.Builder().code(403).build())
        server.enqueue(MockResponse.Builder().body("<html>").build())
        assertEquals(Remote.Failed(Failure.Forbidden), remote { api().version() })
        assertEquals(Remote.Failed(Failure.BadResponse), remote { api().config() })
    }

    @Test
    fun aFailureTheAppDescribesItselfKeepsItsText() {
        assertEquals(Remote.Failed(Failure.Other("Not signed in")), Remote.Failed("Not signed in"))
    }
}
