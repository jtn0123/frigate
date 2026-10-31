package com.jtn.frigateviewer.data

import java.io.IOException
import java.net.HttpURLConnection.HTTP_UNAUTHORIZED
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** What Frigate's `/ws` feed says, reduced to what the app shows. */
sealed interface FeedEvent {
    /**
     * The feed is open; anything missed while it was closed has to be fetched.
     * [commands] reach the server for as long as it stays open.
     */
    class Connected(val commands: FeedCommands) : FeedEvent

    /** A review item began ("new"), changed ("update") or finished ("end"). */
    data class Review(val type: String, val item: ReviewItem) : FeedEvent

    /** Every camera's current state, sent once after connecting. */
    data class Activity(val cameras: Map<String, CameraActivity>) : FeedEvent

    data class Motion(val camera: String, val active: Boolean) : FeedEvent

    /** A camera switch changed, such as `detect` or `recordings`, by anyone. */
    data class Switch(val camera: String, val switch: String, val on: Boolean) : FeedEvent
}

/** Sends a command over the open feed, as Frigate's web UI does; false once the feed has closed. */
fun interface FeedCommands {
    fun send(topic: String, payload: String): Boolean
}

/** What a camera sees right now, and its switches as the server reports them. */
data class CameraActivity(
    val motion: Boolean = false,
    val objects: List<String> = emptyList(),
    val switches: Map<String, Boolean> = emptyMap(),
)

/**
 * Opens the feed on [client]; it ends with an [IOException] when the connection
 * drops, an [AuthException] when the server refuses the session.
 */
internal fun eventFeed(client: OkHttpClient, url: String): Flow<FeedEvent> = callbackFlow {
    val socket = client.newWebSocket(
        Request.Builder().url(url).build(),
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // Frigate answers this with every camera's state.
                webSocket.send("""{"topic":"onConnect","payload":""}""")
                trySend(
                    FeedEvent.Connected { topic, payload ->
                        webSocket.send(
                            buildJsonObject {
                                put("topic", topic)
                                put("payload", payload)
                            }.toString(),
                        )
                    },
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                parseFeedMessage(text)?.let { trySend(it) }
            }

            // A clean close from the server (a restart) waits for the app's answer; without
            // it the feed would look connected until the TCP connection timed out.
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                close(IOException("The server closed the feed ($code)"))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                close(IOException("The server closed the feed ($code)"))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // A refused upgrade is the session ending, not the connection dropping.
                close(
                    if (response?.code == HTTP_UNAUTHORIZED) {
                        AuthException("Not authorized for the live feed (HTTP $HTTP_UNAUTHORIZED)")
                    } else {
                        t as? IOException ?: IOException(t)
                    },
                )
            }
        },
    )
    awaitClose { socket.close(NORMAL_CLOSURE, null) }
}

private const val NORMAL_CLOSURE = 1000

/** The switches Frigate reports as `<camera>/<switch>/state`. */
val CAMERA_SWITCHES = setOf("detect", "recordings", "snapshots", "audio", "enabled", "motion")

private val json = Json { ignoreUnknownKeys = true }

/**
 * Reads one `{"topic", "payload"}` message; null for topics the app does not
 * use or a message it cannot read. Payloads are often JSON sent as a string.
 */
fun parseFeedMessage(text: String): FeedEvent? = try {
    val message = Json.parseToJsonElement(text).jsonObject
    val topic = (message["topic"] as? JsonPrimitive)?.contentOrNull
    val payload = message["payload"]
    when {
        topic == null -> null
        topic == "reviews" -> parseReview(payload.unwrap())
        topic == "camera_activity" -> parseActivity(payload.unwrap())
        topic.endsWith("/motion") -> FeedEvent.Motion(topic.substringBefore('/'), payload.text() == "ON")
        else -> parseSwitch(topic, payload.text())
    }
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

private fun parseReview(payload: JsonElement?): FeedEvent? {
    val body = payload as? JsonObject
    val type = body?.get("type").text()
    val after = body?.get("after") as? JsonObject
    if (type == null || after == null) return null
    return FeedEvent.Review(type, json.decodeFromJsonElement(ReviewItem.serializer(), after))
}

private fun parseActivity(payload: JsonElement?): FeedEvent? {
    val cameras = payload as? JsonObject ?: return null
    return FeedEvent.Activity(
        cameras.mapNotNull { (name, value) ->
            val camera = value as? JsonObject ?: return@mapNotNull null
            // A parked car is tracked for hours; only moving objects count as activity.
            val objects = (camera["objects"] as? JsonArray).orEmpty()
                .filterNot { ((it as? JsonObject)?.get("stationary") as? JsonPrimitive)?.booleanOrNull == true }
                .mapNotNull { element -> ((element as? JsonObject)?.get("label") ?: element).text() }
            val config = camera["config"] as? JsonObject
            // This snapshot calls recording "record"; its updates and commands say "recordings".
            val switches = config?.mapNotNull { (key, on) ->
                (on as? JsonPrimitive)?.booleanOrNull?.let { (if (key == "record") "recordings" else key) to it }
            }?.toMap()
            name to CameraActivity(
                motion = (camera["motion"] as? JsonPrimitive)?.booleanOrNull ?: false,
                objects = objects.map { it.removeSuffix("-verified") }.distinct(),
                switches = switches.orEmpty(),
            )
        }.toMap(),
    )
}

/** `<camera>/<switch>/state` with ON or OFF. */
private fun parseSwitch(topic: String, payload: String?): FeedEvent? {
    val parts = topic.split('/')
    if (parts.size != SWITCH_TOPIC_PARTS || parts[2] != "state" || parts[1] !in CAMERA_SWITCHES) return null
    val on = when (payload) {
        "ON" -> true
        "OFF" -> false
        else -> return null
    }
    return FeedEvent.Switch(parts[0], parts[1], on)
}

private const val SWITCH_TOPIC_PARTS = 3

private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.contentOrNull

/** A payload that is JSON inside a string, parsed; anything else as it is. */
private fun JsonElement?.unwrap(): JsonElement? {
    val primitive = this as? JsonPrimitive ?: return this
    if (!primitive.isString) return this
    return Json.parseToJsonElement(primitive.content)
}
