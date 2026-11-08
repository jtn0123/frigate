package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.ClipRequest
import com.jtn.frigateviewer.data.Failure
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.MediaFiles
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.remote
import com.jtn.frigateviewer.data.reviewSnapshot
import com.jtn.frigateviewer.data.saveClip
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch

/** How saving one item's clip is going. */
sealed interface ClipState {
    /** The server is cutting the clip. */
    data object Preparing : ClipState

    data object Downloading : ClipState

    data class Saved(val uri: String) : ClipState

    /** Saving stopped with [message]; [failure] says why, so one that ends the session can sign out. */
    data class Failed(val message: UiText, val failure: Failure? = null) : ClipState {
        constructor(failure: Failure) : this(failure.text, failure)
    }
}

/**
 * Where clips are saved. On a phone that is background work that goes on
 * after the app leaves ([com.jtn.frigateviewer.work.WorkClipJobs]); in
 * process otherwise ([ScopedClipJobs]).
 */
interface ClipJobs {
    /** Whether saving could tell the user how it went in a notification, once they allow notifications. */
    val wantsNotifications: Boolean

    /**
     * Saves [request]'s clip, unless the same item's is already underway, and
     * follows it: the flow ends with [ClipState.Saved] or [ClipState.Failed],
     * or with null if the work was cancelled.
     */
    fun save(api: FrigateApi, request: ClipRequest): Flow<ClipState?>

    /** Stops every clip still saving, as when signing out. */
    fun cancelAll()
}

/** Saves clips in the collecting coroutine itself, so they stop with it; for tests and as a fallback. */
class ScopedClipJobs(private val media: MediaFiles) : ClipJobs {
    override val wantsNotifications: Boolean get() = false

    override fun save(api: FrigateApi, request: ClipRequest): Flow<ClipState?> = flow {
        emit(ClipState.Preparing)
        val result = remote { api.saveClip(media, request, onDownloading = { emit(ClipState.Downloading) }) }
        emit(result.clipState)
    }

    override fun cancelAll() = Unit
}

/** What a finished save comes to. */
internal val Remote<String>.clipState: ClipState
    get() = when (this) {
        is Remote.Ready -> ClipState.Saved(value)
        is Remote.Failed -> ClipState.Failed(failure)
        Remote.Loading -> ClipState.Preparing
    }

/** Something for the share sheet. */
data class ShareRequest(val uri: String, val mime: String)

/**
 * Saving review items' clips to the phone and sharing their snapshots. Clips
 * are saved by [jobs], in the background on a phone, so one keeps saving after
 * its screen, or the app, is left; [scope] follows them for the screens.
 */
class Clips(
    private val scope: CoroutineScope,
    private val onSessionLost: (UiText?) -> Unit,
    private val media: MediaFiles?,
    private val jobs: ClipJobs? = media?.let(::ScopedClipJobs),
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
    var notice by mutableStateOf<UiText?>(null)
        private set

    val available: Boolean get() = media != null && jobs != null

    /**
     * Saving a clip asks, once, to allow notifications, which say how it went
     * while the app is away; the activity asks and calls [notificationsAsked].
     * Refused, clips still save, and the screen still shows how it went.
     */
    var asksNotifications by mutableStateOf(false)
        private set
    private var notificationsAsked = false

    fun notificationsAsked() {
        asksNotifications = false
    }

    /**
     * Has Frigate export [item] with a few seconds either side, then saves it
     * to Movies/Frigate. Null when it is already underway or nowhere to save.
     */
    fun save(api: FrigateApi, item: ReviewItem, cameraLabel: String): Job? {
        // Clips go to the device's files, so without them there is no job to run.
        val jobs = jobs.takeIf { media != null }
        val end = item.endTime
        val busy = states[item.id].let { it == ClipState.Preparing || it == ClipState.Downloading }
        if (jobs == null || end == null || busy) return null
        if (jobs.wantsNotifications && !notificationsAsked) {
            notificationsAsked = true
            asksNotifications = true
        }
        set(item.id, ClipState.Preparing)
        val name = clipName(cameraLabel, item.startTime)
        val request = ClipRequest(item.id, item.camera, item.startTime.toLong() - PADDING_SECONDS, end.toLong() + PADDING_SECONDS, name)
        return scope.launch {
            jobs.save(api, request).collect { state ->
                val failure = (state as? ClipState.Failed)?.failure
                if (failure?.endsSession == true) onSessionLost(failure.signInReason)
                states = if (state == null) states - item.id else states + (item.id to state)
            }
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
                    is Remote.Failed -> notice = uiText(R.string.clip_snapshot_failed, result.text)
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

    /** Forgets everything, and stops any clip still saving, for a new session. */
    fun reset() {
        jobs?.cancelAll()
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
