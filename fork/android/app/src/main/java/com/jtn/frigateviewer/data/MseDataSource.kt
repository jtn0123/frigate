package com.jtn.frigateviewer.data

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import java.io.IOException
import java.net.HttpURLConnection.HTTP_FORBIDDEN
import java.net.HttpURLConnection.HTTP_UNAUTHORIZED
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * go2rtc's MSE WebSocket read as one continuous fragmented MP4 byte stream.
 *
 * The protocol is the one the Frigate web UI speaks: the client sends the
 * codecs it can decode, go2rtc answers with the codec it picked, and every
 * binary message after that is the next piece of an fMP4 file (the init
 * segment, then moof/mdat fragments). Concatenated, they are exactly what
 * ExoPlayer's FragmentedMp4Extractor reads.
 */
class MseStream(
    client: OkHttpClient,
    url: String,
    private val readTimeoutSeconds: Long = 10,
    /** The most messages held for the player; a player that falls this far behind ends the stream. */
    maxQueued: Int = MAX_QUEUED,
) {

    private sealed interface Event {
        class Data(val bytes: ByteArray) : Event
        class Failed(val error: IOException) : Event
        data object Closed : Event
    }

    private val events = LinkedBlockingQueue<Event>(maxQueued)

    /** Set when the player fell too far behind and the stream was dropped. */
    @Volatile private var overflow: IOException? = null
    private val socket: WebSocket = client.newWebSocket(Request.Builder().url(url).build(), Listener())
    private var current = ByteArray(0)
    private var position = 0
    private var finished = false

    /** Blocks for the next bytes; returns -1 once the server closes the stream. */
    fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        while (position >= current.size) {
            if (finished) return -1
            when (val event = next()) {
                is Event.Data -> {
                    current = event.bytes
                    position = 0
                }
                is Event.Failed -> throw event.error
                Event.Closed -> finished = true
            }
        }
        val count = minOf(length, current.size - position)
        System.arraycopy(current, position, buffer, offset, count)
        position += count
        return count
    }

    /** The next event, waiting up to the read timeout; a dropped stream fails at once. */
    private fun next(): Event {
        overflow?.let { return Event.Failed(it) }
        return events.poll(readTimeoutSeconds, TimeUnit.SECONDS)
            ?: Event.Failed(IOException("No video from the live stream for $readTimeoutSeconds seconds"))
    }

    fun close() {
        socket.cancel()
        events.clear()
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send("""{"type":"mse","value":"$SUPPORTED_CODECS"}""")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val message = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            if (message["type"]?.jsonPrimitive?.contentOrNull == "error") {
                val detail = message["value"]?.jsonPrimitive?.contentOrNull ?: "unknown error"
                deliver(webSocket, Event.Failed(IOException("Live stream error: $detail")))
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            deliver(webSocket, Event.Data(bytes.toByteArray()))
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
            deliver(webSocket, Event.Closed)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val error = when (response?.code) {
                HTTP_UNAUTHORIZED -> AuthException("Not authorized for live video (HTTP $HTTP_UNAUTHORIZED)")
                HTTP_FORBIDDEN -> HttpException(HTTP_FORBIDDEN, FrigateApi.NOT_ALLOWED)
                else -> IOException("Live stream connection failed", t)
            }
            deliver(webSocket, Event.Failed(error))
        }

        /**
         * Queues [event] for the player. A player that cannot keep up would
         * otherwise hold ever more video in memory, so a full queue ends the
         * stream with an error, which the player retries from the live edge.
         */
        private fun deliver(webSocket: WebSocket, event: Event) {
            if (!events.offer(event) && overflow == null) {
                overflow = IOException("The live stream arrived faster than it could be played")
                webSocket.cancel()
            }
        }
    }

    companion object {
        /**
         * H.264 and H.265 video with AAC audio, which Android devices decode
         * in hardware. go2rtc picks the camera's codecs from this list.
         */
        const val SUPPORTED_CODECS = "avc1.640029,avc1.64002A,avc1.640033,hvc1.1.6.L153.B0,mp4a.40.2,mp4a.40.5"

        /** About 20 seconds of fragments at 25 frames a second, a few tens of megabytes at most. */
        const val MAX_QUEUED = 500
    }
}

/** Media3 adapter so ExoPlayer can play an [MseStream]. It reads from the network (`isNetwork = true`). */
@UnstableApi
class MseDataSource(private val client: OkHttpClient) : BaseDataSource(true) {
    private var stream: MseStream? = null
    private var uri: Uri? = null

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        stream = MseStream(client, dataSpec.uri.toString())
        transferStarted(dataSpec)
        return C.LENGTH_UNSET.toLong()
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val count = checkNotNull(stream).read(buffer, offset, length)
        if (count < 0) return C.RESULT_END_OF_INPUT
        bytesTransferred(count)
        return count
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        stream?.let {
            it.close()
            stream = null
            transferEnded()
        }
    }

    class Factory(private val client: OkHttpClient) : DataSource.Factory {
        override fun createDataSource(): DataSource = MseDataSource(client)
    }
}
