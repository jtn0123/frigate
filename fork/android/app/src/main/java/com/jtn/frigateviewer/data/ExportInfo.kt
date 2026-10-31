package com.jtn.frigateviewer.data

import java.io.IOException
import java.io.OutputStream
import kotlinx.coroutines.delay
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** One entry in Frigate's Exports, from `/api/exports`. */
@Serializable
data class ExportInfo(
    val id: String,
    val name: String = "",
    val camera: String = "",
    @SerialName("in_progress") val inProgress: Boolean = false,
    @SerialName("video_path") val videoPath: String = "",
)

/**
 * Asks Frigate to cut [camera]'s recordings from [start] to [end] (epoch
 * seconds) into one MP4, which also appears in its Exports page. Returns the
 * export's ID; the file is ready once [exportInfo] says it is no longer in progress.
 */
suspend fun FrigateApi.startExport(camera: String, start: Long, end: Long, name: String): String {
    val body = buildJsonObject {
        put("source", "recordings")
        put("name", name)
    }.toString().toRequestBody("application/json".toMediaType())
    val request = Request.Builder().url(url("api/export/$camera/start/$start/end/$end")).post(body).build()
    val reply = call(request) { it.body.string() }
    val id = (json.parseToJsonElement(reply).jsonObject["export_id"] as? JsonPrimitive)?.contentOrNull
    return id ?: throw IOException("The server did not start the export")
}

/** The export, or null while the server has not listed it yet. */
suspend fun FrigateApi.exportInfo(id: String): ExportInfo? =
    json.decodeFromString<List<ExportInfo>>(getText(url("api/exports"))).firstOrNull { it.id == id }

/** Waits for export [id] to finish, checking every [intervalMs], and returns where to download it. */
suspend fun FrigateApi.awaitExport(id: String, intervalMs: Long = EXPORT_POLL_MS, timeoutMs: Long = EXPORT_TIMEOUT_MS): ExportInfo {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        val info = exportInfo(id)
        if (info != null && !info.inProgress && info.videoPath.isNotEmpty()) return info
        delay(intervalMs)
    }
    throw IOException("The export took too long; it may still appear in Frigate's Exports")
}

/** Copies a finished export into [out]. Frigate serves exports from `/exports/`, not their path on disk. */
suspend fun FrigateApi.downloadExport(info: ExportInfo, out: OutputStream) {
    val path = info.videoPath.removePrefix("/media/frigate/").trimStart('/')
    call(Request.Builder().url(url(path)).build()) { response -> response.body.byteStream().use { it.copyTo(out) } }
}

/**
 * A JPEG of [item]: the snapshot of its first tracked object, or else the
 * recorded frame from when it began.
 */
suspend fun FrigateApi.reviewSnapshot(item: ReviewItem): ByteArray {
    val event = item.data.detections.firstOrNull()
    val path = if (event != null) {
        "api/events/$event/snapshot.jpg"
    } else {
        "api/${item.camera}/recordings/${item.startTime + 1}/snapshot.jpg"
    }
    return call(Request.Builder().url(url(path)).build()) { it.body.bytes() }
}

private const val EXPORT_POLL_MS = 2_000L
private const val EXPORT_TIMEOUT_MS = 10 * 60_000L
