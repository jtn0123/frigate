package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.data.AuthException
import com.jtn.frigateviewer.data.CameraActivity
import com.jtn.frigateviewer.data.FeedCommands
import com.jtn.frigateviewer.data.FeedEvent
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.ReviewItem
import java.io.IOException
import kotlinx.coroutines.delay

/**
 * The server's live feed: what each camera sees right now, new and changed
 * review items, and the channel camera commands go out on.
 *
 * [api] is read again before each connection, so signing out ends the loop.
 * [onReconnect] runs when the feed comes back after a drop, to fetch anything
 * missed meanwhile. [onSessionLost] runs when the server refuses the session.
 */
class LiveFeed(
    private val api: () -> FrigateApi?,
    private val onReview: (ReviewItem) -> Unit,
    private val onCommands: (FeedCommands?) -> Unit,
    private val onReconnect: () -> Unit,
    private val onSessionLost: () -> Unit = {},
) {
    /** What each camera sees right now; empty until the feed connects. */
    var activity by mutableStateOf<Map<String, CameraActivity>>(emptyMap())
        private set

    /** Whether the feed is open, so polling can wait. */
    var connected by mutableStateOf(false)
        private set

    /** Follows the feed until cancelled, reconnecting after a drop with a growing pause. */
    suspend fun follow() {
        var pause = RETRY_MIN_MS
        var first = true
        while (true) {
            val api = api() ?: return
            try {
                api.feed().collect { event ->
                    if (event is FeedEvent.Connected) {
                        connected = true
                        onCommands(event.commands)
                        pause = RETRY_MIN_MS
                        if (!first) onReconnect()
                        first = false
                    }
                    apply(event)
                }
            } catch (_: AuthException) {
                // Retrying would be refused forever. Only the session this was tried with is ended;
                // if another took its place meanwhile, that one is tried at once.
                if (api() === api) {
                    onSessionLost()
                    return
                }
                continue
            } catch (_: IOException) {
                // Dropped; polling covers the gap until it reconnects.
            } finally {
                connected = false
                onCommands(null)
            }
            delay(pause)
            pause = (pause * 2).coerceAtMost(RETRY_MAX_MS)
        }
    }

    private fun apply(event: FeedEvent) {
        when (event) {
            is FeedEvent.Connected -> Unit
            is FeedEvent.Review -> onReview(event.item)
            is FeedEvent.Activity -> activity = event.cameras
            is FeedEvent.Motion -> updateActivity(event.camera) {
                it.copy(motion = event.active, objects = if (event.active) it.objects else emptyList())
            }
            is FeedEvent.Switch -> updateActivity(event.camera) { it.copy(switches = it.switches + (event.switch to event.on)) }
        }
    }

    private fun updateActivity(camera: String, change: (CameraActivity) -> CameraActivity) {
        activity = activity + (camera to change(activity[camera] ?: CameraActivity()))
    }

    private companion object {
        const val RETRY_MIN_MS = 2_000L
        const val RETRY_MAX_MS = 60_000L
    }
}
