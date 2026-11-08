package com.jtn.frigateviewer.data

import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection.HTTP_NOT_FOUND
import kotlinx.coroutines.delay
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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

/** The reply to starting an export; only what the app reads. */
@Serializable
private data class StartedExport(@SerialName("export_id") val exportId: String? = null)

/**
 * Asks Frigate to cut [camera]'s recordings from [start] to [end] (epoch
 * seconds) into one MP4, which also appears in its Exports page. Returns the
 * export's ID, to wait for with [awaitExport].
 */
suspend fun FrigateApi.startExport(camera: String, start: Long, end: Long, name: String): String {
    val body = buildJsonObject {
        put("source", "recordings")
        put("name", name)
    }.toString().toRequestBody(FrigateApi.JSON)
    val request = Request.Builder().url(url("api/export/$camera/start/$start/end/$end")).post(body).build()
    val id = call(request) { frigateJson.decodeFromString<StartedExport>(it.body.string()).exportId }
    return id ?: throw IOException("The server did not start the export")
}

/** Export [id] as Frigate has it now, from `/api/exports/<id>`; null when there is none. */
internal suspend fun FrigateApi.exportInfo(id: String): ExportInfo? = orNullIfNotFound { getJson<ExportInfo>(url("api/exports/$id")) }

/**
 * Export [id] from the whole list, for a server without job status: the
 * only way such a server says how an export is going.
 */
private suspend fun FrigateApi.listedExport(id: String): ExportInfo? =
    getBody(url("api/exports")) { reply -> frigateJson.decodeFromString<List<ExportInfo>>(reply).firstOrNull { it.id == id } }

/** Where export job [id] is, from `/api/jobs/export/<id>`; only what the app reads. */
@Serializable
internal data class ExportJob(val status: String = "", @SerialName("error_message") val errorMessage: String? = null) {
    val failed: Boolean get() = status == "failed" || status == "cancelled"
    val succeeded: Boolean get() = status == "success"
}

/**
 * Export job [id], or null when the server does not know it: an older server
 * without the route, or a job dropped a few seconds after it finished.
 */
internal suspend fun FrigateApi.exportJob(id: String): ExportJob? = orNullIfNotFound { getJson<ExportJob>(url("api/jobs/export/$id")) }

private suspend fun <T> orNullIfNotFound(read: suspend () -> T): T? = try {
    read()
} catch (e: HttpException) {
    if (e.code != HTTP_NOT_FOUND) throw e
    null
}

private fun ExportInfo?.isDone() = this != null && !inProgress && videoPath.isNotEmpty()

/**
 * Waits for export [id] to finish, checking its job every [intervalMs], and
 * returns where to download it, read once the job is done. A job that fails,
 * or vanishes without leaving a finished export, ends the wait at once instead
 * of after [timeoutMs]. A server without job status is waited on through its
 * list of exports instead. [clock] tells the time; tests pass virtual time.
 */
suspend fun FrigateApi.awaitExport(
    id: String,
    intervalMs: Long = EXPORT_POLL_MS,
    timeoutMs: Long = EXPORT_TIMEOUT_MS,
    clock: () -> Long = System::currentTimeMillis,
): ExportInfo {
    val deadline = clock() + timeoutMs
    var jobSeen = false
    while (clock() < deadline) {
        val job = exportJob(id)
        when {
            job == null && !jobSeen -> listedExport(id).takeIf { it.isDone() }?.let { return it }
            // A finished job is dropped a few seconds after it ends, so its export says how it went.
            job == null || job.succeeded -> return finishedExport(id)
            job.failed -> throw IOException(exportFailure(job))
        }
        jobSeen = jobSeen || job != null
        delay(intervalMs)
    }
    throw IOException("The export took too long; it may still appear in Frigate's Exports")
}

/** Export [id], read once its job has ended; one that is not there, or not finished, did not work. */
private suspend fun FrigateApi.finishedExport(id: String): ExportInfo =
    exportInfo(id).takeIf { it.isDone() } ?: throw IOException(EXPORT_GONE)

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
internal const val EXPORT_POLL_MS = 2_000L
internal const val EXPORT_TIMEOUT_MS = 10 * 60_000L
