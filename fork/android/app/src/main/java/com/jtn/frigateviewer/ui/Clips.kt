package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.MediaFiles
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.awaitExport
import com.jtn.frigateviewer.data.downloadExport
import com.jtn.frigateviewer.data.reviewSnapshot
import com.jtn.frigateviewer.data.startExport
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** How saving one item's clip is going. */
sealed interface ClipState {
    /** The server is cutting the clip. */
    data object Preparing : ClipState

    data object Downloading : ClipState

    data class Saved(val uri: String) : ClipState

    data class Failed(val message: String) : ClipState
}

/** Something for the share sheet. */
data class ShareRequest(val uri: String, val mime: String)

/**
 * Saving review items' clips to the phone and sharing their snapshots. Work
 * runs in [scope], so a clip keeps saving after its screen is left.
 */
class Clips(
    private val scope: CoroutineScope,
    private val onSessionLost: (String?) -> Unit,
    private val media: MediaFiles?,
) {
    var states by mutableStateOf<Map<String, ClipState>>(emptyMap())
        private set

    /** A share waiting for the screen to open the share sheet; cleared with [shared]. */
    var share by mutableStateOf<ShareRequest?>(null)
        private set

    /** Items whose snapshot is being fetched to share; their Share button waits meanwhile. */
    var sharingSnapshots by mutableStateOf<Set<String>>(emptySet())
        private set

    /** A one-time message, such as a snapshot that could not be fetched; cleared with [noticeShown]. */
    var notice by mutableStateOf<String?>(null)
        private set

    val available: Boolean get() = media != null

    /**
     * Has Frigate export [item] with a few seconds either side, then saves it
     * to Movies/Frigate. Null when it is already underway or nowhere to save.
     */
    fun save(api: FrigateApi, item: ReviewItem, cameraLabel: String): Job? {
        val files = media
        val end = item.endTime
        val busy = states[item.id].let { it == ClipState.Preparing || it == ClipState.Downloading }
        if (files == null || end == null || busy) return null
        set(item.id, ClipState.Preparing)
        return scope.launch {
            val name = clipName(cameraLabel, item.startTime)
            val result = loadRemote(onSessionLost) {
                val id = api.startExport(item.camera, item.startTime.toLong() - PADDING_SECONDS, end.toLong() + PADDING_SECONDS, name)
                val info = api.awaitExport(id)
                set(item.id, ClipState.Downloading)
                files.saveVideo("$name.mp4") { out -> api.downloadExport(info, out) }
            }
            set(
                item.id,
                when (result) {
                    is Remote.Ready -> ClipState.Saved(result.value)
                    is Remote.Failed -> ClipState.Failed(result.message)
                    Remote.Loading -> ClipState.Preparing
                },
            )
        }
    }

    /** Shares the saved clip of [item], if there is one. */
    fun shareClip(item: ReviewItem) {
        (states[item.id] as? ClipState.Saved)?.let { share = ShareRequest(it.uri, "video/mp4") }
    }

    /** Shares [item]'s snapshot; null when it is already being fetched (a double tap) or there is nowhere to put it. */
    fun shareSnapshot(api: FrigateApi, item: ReviewItem, cameraLabel: String): Job? {
        val files = media
        if (files == null || item.id in sharingSnapshots) return null
        sharingSnapshots = sharingSnapshots + item.id
        return scope.launch {
            try {
                val result = loadRemote(onSessionLost) {
                    files.shareable("${clipName(cameraLabel, item.startTime)}.jpg", api.reviewSnapshot(item))
                }
                when (result) {
                    is Remote.Ready -> share = ShareRequest(result.value, "image/jpeg")
                    is Remote.Failed -> notice = "Could not get the snapshot (${result.message})"
                    Remote.Loading -> Unit
                }
            } finally {
                sharingSnapshots = sharingSnapshots - item.id
            }
        }
    }

    fun shared() {
        share = null
    }

    fun noticeShown() {
        notice = null
    }

    /** Forgets everything, for a new session. */
    fun reset() {
        states = emptyMap()
        sharingSnapshots = emptySet()
        share = null
        notice = null
    }

    private fun set(id: String, state: ClipState) {
        states = states + (id to state)
    }

    private companion object {
        /** Seconds kept before and after the item, as when it plays. */
        const val PADDING_SECONDS = 5L
    }
}

private val nameFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd HH.mm.ss")

/** "Driveway 2026-10-30 21.40.12": sorts by time and is safe as a file name. */
internal fun clipName(cameraLabel: String, start: Double): String {
    val label = cameraLabel.replace(Regex("[^A-Za-z0-9 _-]"), "").trim().ifEmpty { "Camera" }
    return "$label ${Instant.ofEpochSecond(start.toLong()).atZone(ZoneId.systemDefault()).format(nameFormat)}"
}
