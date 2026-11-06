package com.jtn.frigateviewer.data

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Signing in to a self-signed server like Frigate's port 8971, and to plain HTTP. */
class SignInTest {
    @get:Rule val serverRule = MockWebServerRule()
    private val server: MockWebServer get() = serverRule.server

    private val serverCert = HeldCertificate.Builder().commonName("frigate.local").addSubjectAlternativeName("frigate.local").build()
    private val fingerprint = certificateFingerprint(serverCert.certificate)
    private val otherFingerprint = certificateFingerprint(HeldCertificate.Builder().build().certificate)

    private val signIn = SignIn()
    private fun url() = server.url("/").toString()
    private fun base() = FrigateApi.normalizeBaseUrl(url())

    private fun useTls() {
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(serverCert).build().sslSocketFactory())
    }

    private fun enqueueLoginAndConfig() {
        server.enqueue(MockResponse.Builder().addHeader("Set-Cookie", "frigate_token=jwt1; Path=/; HttpOnly").body("{}").build())
        server.enqueue(MockResponse.Builder().body("""{"cameras": {}}""").build())
    }

    /** Paths the server was asked for, in order. */
    private fun paths() = List(server.requestCount) { server.takeRequest().url.encodedPath }

    @Test
    fun anUnknownCertificateIsShownBeforeAnythingIsSent() = runTest {
        useTls()

        val result = signIn.signIn(ServerSettings(), url(), "admin", "secret", selfSignedCert = true)

        assertEquals(SignInResult.NeedsTrust(fingerprint, changed = false), result)
        assertEquals("Reading the certificate sends nothing", emptyList<String>(), paths())
    }

    @Test
    fun aTrustedCertificateSignsInAndIsPinned() = runTest {
        useTls()
        enqueueLoginAndConfig()

        val result = signIn.signIn(ServerSettings(), url(), " admin ", "secret", selfSignedCert = true, trustedFingerprint = fingerprint)

        val settings = (result as SignInResult.SignedIn).settings
        assertEquals(fingerprint, settings.certificatePin)
        assertEquals("admin", settings.username)
        assertEquals("jwt1", settings.token)
        assertEquals("frigate_token", settings.tokenCookie)
        assertEquals(listOf("/api/login", "/api/config"), paths())
    }

    @Test
    fun theSavedCertificateForThisAddressNeedsNoPrompt() = runTest {
        useTls()
        enqueueLoginAndConfig()
        val saved = ServerSettings(baseUrl = base(), selfSignedCert = true, certificatePin = fingerprint, gridColumns = 2)

        val result = signIn.signIn(saved, url(), "admin", "secret", selfSignedCert = true)

        val settings = (result as SignInResult.SignedIn).settings
        assertEquals(fingerprint, settings.certificatePin)
        assertEquals("Preferences carry over", 2, settings.gridColumns)
        assertEquals(listOf("/api/login", "/api/config"), paths())
    }

    @Test
    fun aChangedCertificateIsFlaggedAsChanged() = runTest {
        useTls()
        val saved = ServerSettings(baseUrl = base(), selfSignedCert = true, certificatePin = otherFingerprint)

        val result = signIn.signIn(saved, url(), "admin", "secret", selfSignedCert = true)

        assertEquals(SignInResult.NeedsTrust(fingerprint, changed = true), result)
        assertEquals(emptyList<String>(), paths())
    }

    @Test
    fun aPinSavedForAnotherAddressDoesNotCount() = runTest {
        useTls()
        val saved = ServerSettings(baseUrl = "https://192.0.2.1:8971", selfSignedCert = true, certificatePin = fingerprint)

        val result = signIn.signIn(saved, url(), "admin", "secret", selfSignedCert = true)

        assertEquals("A new address is a first visit, not a change", SignInResult.NeedsTrust(fingerprint, changed = false), result)
    }

    @Test
    fun plainHttpSkipsTheCertificateCheck() = runTest {
        server.enqueue(MockResponse.Builder().body("""{"cameras": {}}""").build())
        val probes = mutableListOf<String>()
        val signIn = SignIn {
            probes += it
            error("no certificate over HTTP")
        }

        val result = signIn.signIn(ServerSettings(), url(), "", "", selfSignedCert = true)

        val settings = (result as SignInResult.SignedIn).settings
        assertTrue(probes.isEmpty())
        assertEquals("", settings.certificatePin)
        assertEquals("", settings.token)
        assertEquals(listOf("/api/config"), paths())
    }

    @Test
    fun aRefusedLoginIsAnAuthFailure() = runTest {
        useTls()
        server.enqueue(MockResponse.Builder().code(401).build())

        val failure = runCatching {
            signIn.signIn(ServerSettings(), url(), "admin", "wrong", selfSignedCert = true, trustedFingerprint = fingerprint)
        }.exceptionOrNull()

        assertTrue("Expected AuthException, got $failure", failure is AuthException)
    }

    @Test
    fun aPasswordIsNeverSentOverPlainHttpToAPublicAddress() = runTest {
        val failure = runCatching {
            signIn.signIn(ServerSettings(), "http://203.0.113.5:5000", "admin", "secret", selfSignedCert = false)
        }.exceptionOrNull()
        assertTrue("Expected InsecureLoginException, got $failure", failure is InsecureLoginException)
    }

    @Test
    fun anAddressThatCannotBeParsedIsReportedAsOne() = runTest {
        val failure = runCatching {
            signIn.signIn(ServerSettings(), "http://nvr:port", "", "", selfSignedCert = false)
        }.exceptionOrNull()
        assertTrue("Expected InvalidAddressException, got $failure", failure is InvalidAddressException)
    }

    @Test
    fun aCapitalizedSchemeIsStillPlainHttp() = runTest {
        val failure = runCatching {
            signIn.signIn(ServerSettings(), "Http://203.0.113.5:5000", "admin", "secret", selfSignedCert = false)
        }.exceptionOrNull()
        assertTrue("Expected InsecureLoginException, got $failure", failure is InsecureLoginException)
    }

    @Test
    fun aCapitalizedHttpsSchemeStillAsksToTrustTheCertificate() = runTest {
        useTls()

        val result = signIn.signIn(ServerSettings(), url().replaceFirst("https", "HTTPS"), "admin", "secret", selfSignedCert = true)

        assertEquals(SignInResult.NeedsTrust(fingerprint, changed = false), result)
        assertEquals(emptyList<String>(), paths())
    }

    @Test
    fun recognizesPrivateAddresses() {
        listOf(
            "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.10", "127.0.0.1", "169.254.1.1",
            "fd12::1", "::1", "nvr", "frigate.local", "frigate.home.arpa",
            // Range edges.
            "10.255.255.255", "172.31.255.255",
        ).forEach { host ->
            assertTrue("$host is private", isPrivateHost(host))
        }
        listOf(
            "8.8.8.8", "172.32.0.1", "192.169.1.1", "100.128.0.1", "2001:db8::1", "frigate.example.com", "10.0.0.1.example.com",
            "9.255.255.255", "11.0.0.0", "100.63.255.255", "172.15.255.255", "256.1.1.1",
            // Carrier-grade NAT is asked about instead.
            "100.101.102.103", "100.64.0.0", "100.127.255.255",
        )
            .forEach { host -> assertFalse("$host is public", isPrivateHost(host)) }
    }

    @Test
    fun recognizesCarrierGradeNatAddresses() {
        listOf("100.64.0.0", "100.101.102.103", "100.127.255.255", "100.100.1.1.")
            .forEach { host -> assertTrue("$host is shared", isSharedAddress(host)) }
        listOf("100.63.255.255", "100.128.0.0", "10.1.2.3", "nvr", "100.64.example.com")
            .forEach { host -> assertFalse("$host is not shared", isSharedAddress(host)) }
    }

    @Test
    fun aPasswordOverPlainHttpToATailscaleAddressWaitsForConsent() = runTest {
        // Tailscale gives devices 100.64.0.0/10 addresses, as do mobile carriers: not refused, but asked about.
        val result = signIn.signIn(ServerSettings(), "http://100.101.102.103:5000", "admin", "secret", selfSignedCert = false)

        assertEquals(SignInResult.NeedsHttpConsent("100.101.102.103"), result)
    }

    @Test
    fun consentLetsAPasswordGoToACarrierGradeNatAddressOnly() {
        assertNull(plainHttpCheck(https = false, host = "100.101.102.103", user = "admin", consent = true))
        assertEquals(
            SignInResult.NeedsHttpConsent("100.101.102.103"),
            plainHttpCheck(https = false, host = "100.101.102.103", user = "admin", consent = false),
        )
        assertNull("No password, nothing to protect", plainHttpCheck(https = false, host = "100.101.102.103", user = " ", consent = false))
        assertNull(plainHttpCheck(https = true, host = "100.101.102.103", user = "admin", consent = false))
        assertNull(plainHttpCheck(https = false, host = "192.168.1.10", user = "admin", consent = false))
        val failure = runCatching { plainHttpCheck(https = false, host = "203.0.113.5", user = "admin", consent = true) }.exceptionOrNull()
        assertTrue("Consent never covers a public address, got $failure", failure is InsecureLoginException)
    }

    @Test
    fun signingInAgainClearsSigningOut() = runTest {
        server.enqueue(MockResponse.Builder().body("""{"cameras": {}}""").build())
        val signedOut = ServerSettings(baseUrl = base(), signedOut = true)

        val result = signIn.signIn(signedOut, url(), "", "", selfSignedCert = false)

        val settings = (result as SignInResult.SignedIn).settings
        assertFalse(settings.signedOut)
        assertTrue(settings.canResume)
    }
}
