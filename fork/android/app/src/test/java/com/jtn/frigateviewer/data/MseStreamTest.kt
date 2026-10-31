package com.jtn.frigateviewer.data

import com.jtn.frigateviewer.data.liveUrl
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Talks to a fake go2rtc that speaks the MSE WebSocket protocol. */
class MseStreamTest {
    @get:Rule val serverRule = MockWebServerRule()

    private val client = buildHttpClient(AuthToken("frigate_token", "tok"), pin = null)

    private fun liveUrl() = FrigateApi(client, serverRule.server.url("/").toString()).liveUrl("front_door")

    @Test
    fun streamsBinaryMessagesAsOneByteStream() {
        val requests = LinkedBlockingQueue<String>()
        serverRule.server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    requests.put(text)
                    webSocket.send("""{"type":"mse","value":"video/mp4; codecs=\"avc1.640029\""}""")
                    webSocket.send(byteArrayOf(1, 2, 3).toByteString())
                    webSocket.send(byteArrayOf(4, 5).toByteString())
                    webSocket.close(1000, null)
                }
            }).build(),
        )

        val source = MseStream(client, liveUrl())
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(2)
        while (true) {
            val read = source.read(buffer, 0, buffer.size)
            if (read < 0) break
            out.write(buffer, 0, read)
        }
        source.close()

        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5), out.toByteArray())
        val hello = requests.poll(5, TimeUnit.SECONDS)
        assertTrue(hello!!.startsWith("""{"type":"mse","value":"avc1"""))
        val handshake = serverRule.server.takeRequest()
        assertEquals("/live/mse/api/ws", handshake.url.encodedPath)
        assertEquals("front_door", handshake.url.queryParameter("src"))
        assertEquals("frigate_token=tok", handshake.headers["Cookie"])
    }

    @Test
    fun aPlayerThatFallsBehindEndsTheStreamInsteadOfBufferingForever() {
        val closed = LinkedBlockingQueue<Throwable>()
        serverRule.server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    repeat(20) { webSocket.send(byteArrayOf(it.toByte()).toByteString()) }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    closed.put(t)
                }
            }).build(),
        )
        val source = MseStream(client, liveUrl(), maxQueued = 4)

        assertTrue("The server sees the stream dropped", closed.poll(5, TimeUnit.SECONDS) != null)
        val error = runCatching { repeat(20) { source.read(ByteArray(1), 0, 1) } }.exceptionOrNull()
        source.close()
        assertTrue("Expected the overflow, got $error", error?.message?.contains("faster than it could be played") == true)
    }

    @Test
    fun go2rtcErrorBecomesIOException() {
        serverRule.server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = Unit
                override fun onMessage(webSocket: WebSocket, text: String) {
                    webSocket.send("""{"type":"error","value":"streams: codecs not matched"}""")
                }
            }).build(),
        )
        val source = MseStream(client, liveUrl())
        val error = runCatching { source.read(ByteArray(8), 0, 8) }.exceptionOrNull()
        source.close()
        assertTrue(error is IOException)
        assertTrue(error!!.message!!.contains("codecs not matched"))
    }
}
