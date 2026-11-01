package com.jtn.frigateviewer.data

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The auth cookie goes to the Frigate server and nowhere else, redirects included. */
class AuthCookieTest {
    @get:Rule val frigateRule = MockWebServerRule()

    @get:Rule val otherRule = MockWebServerRule()
    private val frigate: MockWebServer get() = frigateRule.server
    private val other: MockWebServer get() = otherRule.server

    @Test
    fun aRedirectToAnotherServerDoesNotCarryTheCookie() = runTest {
        frigate.enqueue(MockResponse.Builder().code(302).addHeader("Location", other.url("/api/version").toString()).build())
        other.enqueue(MockResponse.Builder().body("0.17.0").build())
        val auth = AuthToken(frigate.url("/").toString(), "frigate_token", "tok")

        assertEquals("0.17.0", FrigateApi(buildHttpClient(auth, pin = null), frigate.url("/").toString()).version())

        assertEquals("frigate_token=tok", frigate.takeRequest().headers["Cookie"])
        assertNull("The other server got the token", other.takeRequest().headers["Cookie"])
    }

    @Test
    fun anotherServerCannotReplaceTheToken() = runTest {
        frigate.enqueue(MockResponse.Builder().code(302).addHeader("Location", other.url("/api/version").toString()).build())
        other.enqueue(MockResponse.Builder().addHeader("Set-Cookie", "frigate_token=planted; Path=/").body("0.17.0").build())
        val renewed = mutableListOf<String>()
        val auth = AuthToken(frigate.url("/").toString(), "frigate_token", "tok", renewed::add)

        FrigateApi(buildHttpClient(auth, pin = null), frigate.url("/").toString()).version()

        assertEquals("tok", auth.current)
        assertTrue(renewed.isEmpty())
    }

    @Test
    fun aRedirectWithinTheServerKeepsTheCookie() = runTest {
        frigate.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/api/version/").build())
        frigate.enqueue(MockResponse.Builder().body("0.17.0").build())
        val auth = AuthToken(frigate.url("/").toString(), "frigate_token", "tok")

        FrigateApi(buildHttpClient(auth, pin = null), frigate.url("/").toString()).version()

        assertEquals("frigate_token=tok", frigate.takeRequest().headers["Cookie"])
        assertEquals("frigate_token=tok", frigate.takeRequest().headers["Cookie"])
    }

    @Test
    fun onlyTheSameSchemeHostAndPortGetTheToken() {
        val auth = AuthToken("https://nvr.lan:8971", "frigate_token", "tok")
        assertTrue(auth.belongsTo("https://nvr.lan:8971/api/version".toHttpUrl()))
        assertFalse("A downgrade to plain HTTP", auth.belongsTo("http://nvr.lan:8971/api/version".toHttpUrl()))
        assertFalse("Another port", auth.belongsTo("https://nvr.lan:8443/api/version".toHttpUrl()))
        assertFalse("Another host", auth.belongsTo("https://evil.example:8971/api/version".toHttpUrl()))
        assertFalse("A default port is still another port", auth.belongsTo("https://nvr.lan/api/version".toHttpUrl()))
    }

    @Test
    fun anAddressThatCannotBeParsedGetsNoToken() {
        assertFalse(AuthToken("", "frigate_token", "tok").belongsTo("http://nvr.lan:5000/".toHttpUrl()))
    }
}
