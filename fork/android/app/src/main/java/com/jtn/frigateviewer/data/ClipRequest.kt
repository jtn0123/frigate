package com.jtn.frigateviewer.data

/**
 * A review item's clip to save: [camera]'s recordings from [start] to [end]
 * (epoch seconds), saved as "[name].mp4".
 */
data class ClipRequest(val itemId: String, val camera: String, val start: Long, val end: Long, val name: String)

/**
 * Saves [request]'s clip to [media] and returns where: has Frigate export it,
 * unless [exportId] says it already started (as before the work was stopped
 * and started again), waits for it, and downloads it. [onStarted] is told the
 * new export's ID, and [onDownloading] when the download begins.
 */
suspend fun FrigateApi.saveClip(
    media: MediaFiles,
    request: ClipRequest,
    exportId: String? = null,
    onStarted: suspend (String) -> Unit = {},
    onDownloading: suspend () -> Unit = {},
): String {
    val id = exportId ?: startExport(request.camera, request.start, request.end, request.name).also { onStarted(it) }
    val info = awaitExport(id)
    onDownloading()
    return media.saveVideo("${request.name}.mp4") { out -> downloadExport(info, out) }
}
