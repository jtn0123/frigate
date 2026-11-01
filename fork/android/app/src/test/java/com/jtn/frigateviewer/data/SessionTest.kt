package com.jtn.frigateviewer.data

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** What the server changes during a session reaches the saved settings. */
class SessionTest {
    @get:Rule val serverRule = MockWebServerRule()
    private val server: MockWebServer get() = serverRule.server

    @Test
    fun aRenewedTokenIsSaved() = runTest {
        server.enqueue(MockResponse.Builder().addHeader("Set-Cookie", "frigate_token=renewed; Path=/").body("0.17.0").build())
        var saved = ServerSettings(baseUrl = server.url("/").toString(), username = "admin", token = "expiring", gridColumns = 2)

        Session.saving(saved) { change -> saved = change(saved) }.api.version()

        assertEquals("renewed", saved.token)
        assertEquals("Nothing else changes", 2, saved.gridColumns)
        assertEquals("frigate_token=expiring", server.takeRequest().headers["Cookie"])
    }

    @Test
    fun aSelfSignedServerWithNoSavedPinIsNotTrustedSilently() = runTest {
        val cert = HeldCertificate.Builder().commonName("frigate.local").build()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory())
        server.enqueue(MockResponse.Builder().body("0.17.0").build())
        var saved = ServerSettings(baseUrl = server.url("/").toString(), selfSignedCert = true)

        val result = remote { Session.saving(saved) { change -> saved = change(saved) }.api.version() }

        assertEquals(Remote.Failed(Failure.CertificateUntrusted), result)
        assertEquals("No certificate is saved unseen", "", saved.certificatePin)
        assertEquals("Nothing was sent", 0, server.requestCount)
    }
}
