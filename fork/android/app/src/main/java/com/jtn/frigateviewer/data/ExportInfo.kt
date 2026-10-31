package com.jtn.frigateviewer.data

import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection.HTTP_NOT_FOUND
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

/** Where export job [id] is, from `/api/jobs/export/<id>`; only what the app reads. */
@Serializable
internal data class ExportJob(val status: String = "", @SerialName("error_message") val errorMessage: String? = null) {
    val failed: Boolean get() = status == "failed" || status == "cancelled"
}

/**
 * Export job [id], or null when the server does not know it: an older server
 * without the route, or a job dropped a few seconds after it finished.
 */
internal suspend fun FrigateApi.exportJob(id: String): ExportJob? = try {
    json.decodeFromString<ExportJob>(getText(url("api/jobs/export/$id")))
} catch (e: HttpException) {
    if (e.code != HTTP_NOT_FOUND) throw e
    null
}

private fun ExportInfo?.isDone() = this != null && !inProgress && videoPath.isNotEmpty()

/**
 * Waits for export [id] to finish, checking every [intervalMs], and returns
 * where to download it. A failed export never appears as finished, so its
 * job is checked too: a job that failed, or vanished without leaving a
 * finished export, ends the wait at once instead of after [timeoutMs].
 */
suspend fun FrigateApi.awaitExport(id: String, intervalMs: Long = EXPORT_POLL_MS, timeoutMs: Long = EXPORT_TIMEOUT_MS): ExportInfo {
    val deadline = System.currentTimeMillis() + timeoutMs
    var jobSeen = false
    var checksSinceJobGone = 0
    while (System.currentTimeMillis() < deadline) {
        exportInfo(id).takeIf { it.isDone() }?.let { return it }
        val job = exportJob(id)
        jobSeen = jobSeen || job != null
        // A finished job is dropped after a few seconds; give its export one more check to be listed.
        checksSinceJobGone = if (job == null && jobSeen) checksSinceJobGone + 1 else 0
        val failure = when {
            job?.failed == true -> exportFailure(job)
            checksSinceJobGone > 1 -> EXPORT_GONE
            else -> null
        }
        failure?.let { throw IOException(it) }
        delay(intervalMs)
    }
    throw IOException("The export took too long; it may still appear in Frigate's Exports")
}

private fun exportFailure(job: ExportJob) =
    "The server could not make the clip" + (job.errorMessage?.takeIf { it.isNotBlank() }?.let { " ($it)" } ?: "")

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

private const val EXPORT_GONE = "The server stopped making the clip"
private const val EXPORT_POLL_MS = 2_000L
private const val EXPORT_TIMEOUT_MS = 10 * 60_000L
