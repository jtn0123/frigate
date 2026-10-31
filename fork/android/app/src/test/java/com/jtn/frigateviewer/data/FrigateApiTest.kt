package com.jtn.frigateviewer.data

import com.jtn.frigateviewer.data.liveUrl
import com.jtn.frigateviewer.data.reviewVodUrl
import com.jtn.frigateviewer.data.reviews
import com.jtn.frigateviewer.data.thumbnailUrl
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class FrigateApiTest {
    @get:Rule val serverRule = MockWebServerRule()
    private val server: MockWebServer get() = serverRule.server

    private fun api(auth: AuthToken? = null) = FrigateApi(buildHttpClient(auth, pin = null), server.url("/").toString())

    @Test
    fun normalizesBaseUrls() {
        assertEquals("http://10.0.0.5:5000/", FrigateApi.normalizeBaseUrl("10.0.0.5:5000"))
        assertEquals("https://nvr.local:8971/", FrigateApi.normalizeBaseUrl(" https://nvr.local:8971/ "))
        assertEquals("https://nvr.local:8971/", FrigateApi.normalizeBaseUrl("Https://nvr.local:8971"))
        assertEquals("http://NVR.local/", FrigateApi.normalizeBaseUrl("HTTP://NVR.local"))
    }

    @Test
    fun loginReturnsTokenFromCookie() = runTest {
        server.enqueue(
            MockResponse.Builder()
                .addHeader("Set-Cookie", "frigate_token=abc.def.ghi; HttpOnly; Path=/; Max-Age=86400")
                .body("{}")
                .build(),
        )
        assertEquals(LoginToken("frigate_token", "abc.def.ghi"), api().login("admin", "pw"))
        val request = server.takeRequest()
        assertEquals("/api/login", request.url.encodedPath)
        assertEquals("1", request.headers["X-CSRF-TOKEN"])
        assertEquals("""{"user":"admin","password":"pw"}""", request.body?.utf8())
    }

    @Test
    fun logoutEndsTheSessionWithoutFollowingTheRedirect() = runTest {
        server.enqueue(
            MockResponse.Builder()
                .code(303)
                .addHeader("Location", "/login")
                .addHeader("Set-Cookie", "frigate_token=\"\"; Max-Age=0; Path=/")
                .build(),
        )
        var renewed: String? = null
        api(AuthToken("frigate_token", "jwt1") { renewed = it }).logout()

        val request = server.takeRequest()
        assertEquals("/api/logout", request.url.encodedPath)
        assertEquals("frigate_token=jwt1", request.headers["Cookie"])
        assertEquals("The redirect is not followed", 1, server.requestCount)
        assertNull("Deleting the cookie is not a renewal", renewed)
    }

    @Test(expected = AuthException::class)
    fun loginFailureIsAuthException() = runTest {
        server.enqueue(MockResponse.Builder().code(401).body("""{"message":"Login failed"}""").build())
        api().login("admin", "wrong")
    }

    @Test
    fun forbiddenIsAnOrdinaryFailureNotASignOut() = runTest {
        server.enqueue(MockResponse.Builder().code(403).body("""{"detail":"Access denied to camera 'back'"}""").build())
        val failure = runCatching { api().config() }.exceptionOrNull()
        assertFalse("Not a sign-out", failure is AuthException)
        assertEquals(403, (failure as HttpException).code)
        assertEquals(FrigateApi.NOT_ALLOWED, failure.message)
    }

    @Test
    fun allowedCamerasAreReadFromTheProfile() = runTest {
        server.enqueue(MockResponse.Builder().body("""{"username":"v","role":"viewer","allowed_cameras":["front"]}""").build())
        server.enqueue(MockResponse.Builder().body("""{"username":"v","role":"viewer"}""").build())
        server.enqueue(MockResponse.Builder().code(404).build())
        assertEquals(setOf("front"), api().allowedCameras())
        assertNull("An older server does not say", api().allowedCameras())
        assertNull("No profile hides nothing", api().allowedCameras())
    }

    @Test
    fun loginKeepsCustomCookieName() = runTest {
        server.enqueue(MockResponse.Builder().addHeader("Set-Cookie", "nvr_auth=xyz; Path=/").body("{}").build())
        assertEquals(LoginToken("nvr_auth", "xyz"), api().login("admin", "pw"))
    }

    @Test
    fun sendsTokenAsCookie() = runTest {
        server.enqueue(MockResponse.Builder().body("0.17.0").build())
        assertEquals("0.17.0", api(AuthToken("frigate_token", "tok")).version())
        val request = server.takeRequest()
        assertEquals("frigate_token=tok", request.headers["Cookie"])
        assertNull(request.headers["Authorization"])
    }

    @Test
    fun adoptsRenewedTokenAndReportsIt() = runTest {
        val renewed = mutableListOf<String>()
        val auth = AuthToken("frigate_token", "old", renewed::add)
        server.enqueue(
            MockResponse.Builder()
                .addHeader("Set-Cookie", "other=1; Path=/")
                .addHeader("Set-Cookie", "frigate_token=new; HttpOnly; Path=/; Max-Age=86400")
                .body("0.17.0")
                .build(),
        )
        server.enqueue(MockResponse.Builder().body("0.17.0").build())
        val api = api(auth)
        api.version()
        api.version()

        assertEquals("frigate_token=old", server.takeRequest().headers["Cookie"])
        assertEquals("frigate_token=new", server.takeRequest().headers["Cookie"])
        assertEquals(listOf("new"), renewed)
        assertEquals("new", auth.current)
    }

    @Test
    fun ignoresCookieDeletion() = runTest {
        val auth = AuthToken("frigate_token", "tok")
        server.enqueue(MockResponse.Builder().addHeader("Set-Cookie", "frigate_token=; Max-Age=0; Path=/").body("x").build())
        api(auth).version()
        assertEquals("tok", auth.current)
    }

    @Test
    fun parsesCamerasSortedAndSkipsHiddenOnes() {
        val config = """
            {"cameras": {
              "garage": {"enabled": true, "ui": {"order": 2, "dashboard": true},
                         "detect": {"width": 1280, "height": 720}, "live": {"streams": {"Main": "garage_main"}}},
              "front_door": {"enabled": false, "ui": {"order": 1}, "friendly_name": "Front Door",
                             "detect": {"width": 640, "height": 480}},
              "hidden": {"ui": {"dashboard": false}}
            },
            "go2rtc": {"streams": {"garage_main": ["rtsp://*:*@10.0.0.2/main"], "front_door": "rtsp://*:*@10.0.0.3/"}}}
        """.trimIndent()
        val parsed = FrigateApi.parseConfig(config)
        assertEquals(setOf("garage_main", "front_door"), parsed.liveStreams)
        val cameras = parsed.cameras
        assertEquals(listOf("front_door", "garage"), cameras.map { it.name })
        assertEquals("Front Door", cameras[0].label)
        assertFalse(cameras[0].enabled)
        assertEquals("front_door", cameras[0].primaryStream)
        assertEquals("garage_main", cameras[1].primaryStream)
        assertEquals(16f / 9f, cameras[1].aspectRatio, 0.001f)
    }

    @Test
    fun configWithoutGo2rtcHasUnknownStreams() {
        assertNull(FrigateApi.parseConfig("""{"cameras": {}}""").liveStreams)
    }

    @Test
    fun parsesReviewsAndBuildsMediaUrls() = runTest {
        server.enqueue(
            MockResponse.Builder().body(
                """[{"id":"r1","camera":"front_door","start_time":1000.5,"end_time":1030.2,
                    "has_been_reviewed":false,"severity":"alert",
                    "thumb_path":"/media/frigate/clips/review/thumb-front_door-r1.webp",
                    "data":{"objects":["person","person-verified"],"zones":["yard"],"audio":[],"detections":["x"]}},
                   {"id":"r2","camera":"garage","start_time":2000.0,"end_time":null,
                    "has_been_reviewed":true,"severity":"detection","thumb_path":"/media/frigate/clips/review/t2.webp",
                    "data":{}}]""",
            ).build(),
        )
        val api = api()
        val reviews = api.reviews(Severity.ALERT, camera = "front_door")
        val query = server.takeRequest().url
        assertEquals("alert", query.queryParameter("severity"))
        assertEquals("front_door", query.queryParameter("cameras"))

        assertEquals(2, reviews.size)
        assertTrue(reviews[0].isAlert)
        assertEquals(listOf("person"), reviews[0].labels)
        assertNull(reviews[1].endTime)
        assertEquals(server.url("/clips/review/thumb-front_door-r1.webp").toString(), api.thumbnailUrl(reviews[0]))
        assertEquals(server.url("/vod/front_door/start/995/end/1035/index.m3u8").toString(), api.reviewVodUrl(reviews[0]))
        assertEquals(
            server.url("/live/mse/api/ws?src=garage_main").toString().replaceFirst("http", "ws"),
            api.liveUrl("garage_main"),
        )
        assertEquals("Person", reviews[0].title)
        assertEquals("Detection", reviews[1].title)
    }
}
