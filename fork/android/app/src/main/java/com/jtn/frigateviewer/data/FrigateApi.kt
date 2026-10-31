package com.jtn.frigateviewer.data

import java.io.IOException
import java.net.HttpURLConnection.HTTP_FORBIDDEN
import java.net.HttpURLConnection.HTTP_UNAUTHORIZED
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** The server no longer accepts this session (HTTP 401): it has to be signed in again. */
class AuthException(message: String) : IOException(message)

/**
 * The server answered [code], which is not a success. A 403 is one of these,
 * not an [AuthException]: Frigate sends it when this account may not see a
 * camera or do something, while the session itself stays good.
 */
class HttpException(val code: Int, message: String) : IOException(message)

/** The JWT from a login and the name of the cookie Frigate delivered it in (`auth.cookie_name`). */
data class LoginToken(val cookieName: String, val token: String)

/** Thin client for the parts of the Frigate HTTP API this app uses. */
class FrigateApi(private val client: OkHttpClient, baseUrl: String) {

    val base: HttpUrl = normalizeBaseUrl(baseUrl).toHttpUrl()

    internal val json = Json { ignoreUnknownKeys = true }

    /**
     * Logs in and returns the JWT. Frigate only delivers it as a cookie, so
     * the first cookie on the response is taken, whatever `auth.cookie_name` is.
     */
    suspend fun login(user: String, password: String): LoginToken {
        val body = buildJsonObject {
            put("user", user)
            put("password", password)
        }.toString().toRequestBody(JSON)
        val request = Request.Builder().url(url("api/login")).post(body).build()
        return call(request) { response ->
            response.headers("Set-Cookie")
                .firstNotNullOfOrNull { cookie ->
                    val pair = cookie.substringBefore(';').trim()
                    val name = pair.substringBefore('=')
                    cookieValue(cookie, name)?.let { LoginToken(name, it) }
                }
                ?: throw IOException("Login succeeded but no token was returned")
        }
    }

    /**
     * Ends the session on the server, so the token stops working now rather
     * than when it expires. Frigate answers with a redirect to its login page,
     * which is not followed.
     */
    suspend fun logout() = withContext(Dispatchers.IO) {
        client.newBuilder().followRedirects(false).callTimeout(LOGOUT_TIMEOUT_SECONDS, TimeUnit.SECONDS).build()
            .newCall(Request.Builder().url(url("api/logout")).build())
            .execute()
            .close()
    }

    suspend fun version(): String = getText("api/version").trim()

    suspend fun config(): ServerConfig = parseConfig(getText("api/config"))

    suspend fun stats(): ServerStats = parseStats(getText("api/stats"))

    /** One JPEG frame of the camera's current view. */
    suspend fun latestFrame(camera: String, height: Int): ByteArray {
        val url = base.newBuilder().addPathSegments("api/$camera/latest.jpg")
            .addQueryParameter("h", height.toString())
            .addQueryParameter("cache", System.currentTimeMillis().toString())
            .build()
        return call(Request.Builder().url(url).build()) { it.body.bytes() }
    }

    /** Frigate's live feed of reviews, motion and camera switches, on the same login as everything else. */
    fun feed(): Flow<FeedEvent> = eventFeed(client, url("ws").toString())

    internal fun url(path: String): HttpUrl = base.newBuilder().addPathSegments(path).build()

    internal suspend fun getText(path: String): String = getText(url(path))

    internal suspend fun getText(url: HttpUrl): String =
        call(Request.Builder().url(url).build()) { it.body.string() }

    /**
     * Runs [request] and hands a successful response to [read]. Cancelling the
     * caller cancels the call itself, so a timeout such as the widget's really
     * stops waiting for a slow server instead of blocking until OkHttp gives up.
     */
    internal suspend fun <T> call(request: Request, read: (Response) -> T): T = withContext(Dispatchers.IO) {
        val call = client.newCall(request)
        val cancelOnCancel = launch {
            try {
                awaitCancellation()
            } finally {
                call.cancel()
            }
        }
        try {
            call.execute().use { response ->
                when {
                    response.code == HTTP_UNAUTHORIZED -> throw AuthException("Not authorized (HTTP ${response.code})")
                    response.code == HTTP_FORBIDDEN -> throw HttpException(response.code, NOT_ALLOWED)
                    !response.isSuccessful -> throw HttpException(response.code, "HTTP ${response.code} for ${request.url.encodedPath}")
                    else -> read(response)
                }
            }
        } catch (e: IOException) {
            // Cancelled with its caller: say so, rather than fail as if the network had.
            ensureActive()
            throw e
        } finally {
            cancelOnCancel.cancel()
        }
    }

    companion object {
        /** The most review items fetched at once; more in 24 hours are left out. */
        const val REVIEW_LIMIT = 1000

        /** Signing out does not wait longer than this for the server. */
        private const val LOGOUT_TIMEOUT_SECONDS = 5L

        internal val JSON = "application/json".toMediaType()

        /** What a 403 means for a signed-in user. */
        const val NOT_ALLOWED = "Your account is not allowed to see or do this (HTTP 403)"

        /**
         * Accepts `host:port`, adds `http://` when no scheme is given, lowercases
         * the scheme (so `Https://` is checked as `https://`), and drops a trailing slash.
         */
        fun normalizeBaseUrl(input: String): String {
            val trimmed = input.trim().trimEnd('/')
            val withScheme = if ("://" in trimmed) {
                trimmed.substringBefore("://").lowercase() + "://" + trimmed.substringAfter("://")
            } else {
                "http://$trimmed"
            }
            return "$withScheme/"
        }

        /**
         * Reads cameras and go2rtc stream names from the full config, tolerating
         * fields older versions lack. Stream names come from here rather than
         * `/api/go2rtc/streams` because Frigate masks the credentials in this
         * copy, so camera passwords never reach the phone.
         */
        fun parseConfig(configJson: String): ServerConfig {
            val root = Json.parseToJsonElement(configJson).jsonObject
            return ServerConfig(
                cameras = parseCameras(root),
                liveStreams = root.obj("go2rtc")?.obj("streams")?.keys,
                semanticSearch = root.obj("semantic_search")?.get("enabled")?.jsonPrimitive?.booleanOrNull ?: false,
            )
        }

        private fun parseCameras(root: JsonObject): List<Camera> {
            val cameras = root.obj("cameras") ?: return emptyList()
            return cameras.map { (name, element) ->
                val cam = element.jsonObject
                val ui = cam.obj("ui")
                val detect = cam.obj("detect")
                val streams = cam.obj("live")?.obj("streams")
                    ?.mapNotNull { (label, value) -> value.jsonPrimitive.contentOrNull?.let { label to it } }
                    ?.toMap()
                    .orEmpty()
                Camera(
                    name = name,
                    label = cam["friendly_name"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
                        ?: name.replace('_', ' ').replaceFirstChar { it.uppercase() },
                    order = ui?.get("order")?.jsonPrimitive?.intOrNull ?: 0,
                    enabled = cam["enabled"]?.jsonPrimitive?.booleanOrNull ?: true,
                    liveStreams = streams,
                    width = detect?.get("width")?.jsonPrimitive?.intOrNull ?: 0,
                    height = detect?.get("height")?.jsonPrimitive?.intOrNull ?: 0,
                    onvif = !cam.obj("onvif")?.get("host")?.jsonPrimitive?.contentOrNull.isNullOrBlank(),
                ).takeIf { ui?.get("dashboard")?.jsonPrimitive?.booleanOrNull != false }
            }.filterNotNull().sortedWith(compareBy({ it.order }, { it.label }))
        }

        /**
         * The SHA-256 fingerprint of the certificate [baseUrl] presents, read
         * without trusting it, so the user can decide whether to.
         */
        suspend fun serverCertificate(baseUrl: String): String {
            val pin = CertificatePin(null)
            val failure = try {
                FrigateApi(buildHttpClient(null, pin), baseUrl).version()
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                // Any HTTP answer, even 401, means the handshake already happened.
                e
            }
            return pin.fingerprint ?: throw (failure ?: IOException("The server did not present a certificate"))
        }

        private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
    }
}
