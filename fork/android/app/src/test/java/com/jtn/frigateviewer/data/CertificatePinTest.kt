package com.jtn.frigateviewer.data

import java.io.IOException
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/** A self-signed HTTPS server, like Frigate's port 8971, reached through a pinned client. */
class CertificatePinTest {
    @get:Rule val serverRule = MockWebServerRule()
    private val server: MockWebServer get() = serverRule.server

    // Issued for another name, as a self-signed NVR certificate usually is.
    private val serverCert = HeldCertificate.Builder().commonName("frigate.local").addSubjectAlternativeName("frigate.local").build()
    private val serverFingerprint = certificateFingerprint(serverCert.certificate)
    private val otherFingerprint = certificateFingerprint(HeldCertificate.Builder().build().certificate)

    @Before
    fun useTls() {
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(serverCert).build().sslSocketFactory())
    }

    private fun api(pin: CertificatePin?) = FrigateApi(buildHttpClient(null, pin), server.url("/").toString())

    @Test
    fun acceptsThePinnedCertificate() = runTest {
        server.enqueue(MockResponse.Builder().body("0.17.0").build())
        assertEquals("0.17.0", api(CertificatePin(serverFingerprint)).version())
    }

    @Test
    fun rejectsADifferentCertificate() = runTest {
        try {
            api(CertificatePin(otherFingerprint)).version()
            fail("A certificate that does not match the pin was accepted")
        } catch (e: IOException) {
            val change = e.certificateChange()
            assertNotNull("Expected a certificate change, got $e", change)
            assertEquals(otherFingerprint, change!!.expected)
            assertEquals(serverFingerprint, change.actual)
        }
    }

    @Test
    fun rejectsTheServerWithoutAPin() = runTest {
        try {
            api(pin = null).version()
            fail("A self-signed certificate was trusted without a pin")
        } catch (e: IOException) {
            assertEquals(null, e.certificateChange())
        }
    }

    @Test
    fun pinsTheFirstCertificateWhenNoneIsSaved() = runTest {
        server.enqueue(MockResponse.Builder().body("0.17.0").build())
        val pinned = mutableListOf<String>()
        val pin = CertificatePin(null, pinned::add)
        api(pin).version()
        assertEquals(listOf(serverFingerprint), pinned)
        assertEquals(serverFingerprint, pin.fingerprint)
    }

    @Test
    fun readsTheCertificateEvenWhenLoginIsRequired() = runTest {
        server.enqueue(MockResponse.Builder().code(401).build())
        assertEquals(serverFingerprint, FrigateApi.serverCertificate(server.url("/").toString()))
    }

    @Test
    fun fingerprintLooksLikeABrowsers() {
        assertTrue(Regex("([0-9A-F]{2}:){31}[0-9A-F]{2}").matches(serverFingerprint))
    }
}
