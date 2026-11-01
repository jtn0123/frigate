package com.jtn.frigateviewer.ui

import android.graphics.BitmapFactory
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.jtn.frigateviewer.R
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** A camera's latest picture, and how old it is. */
@Immutable
data class Snapshot(
    val frame: ImageBitmap? = null,
    /** When [frame] arrived, in epoch milliseconds. */
    val takenAt: Long = 0,
    /** When the last try ended, good or not. */
    val checkedAt: Long = 0,
    /** The last try failed. */
    val failed: Boolean = false,
    /** How often it is meant to refresh. */
    val intervalMs: Long = 0,
) {
    /**
     * How long the picture has been out of date, once it is more than twice
     * its refresh interval old: the camera or the connection is down, and the
     * picture showing is not live. Null while it is current.
     */
    val staleMs: Long?
        get() = (checkedAt - takenAt).takeIf { frame != null && failed && it > STALE_INTERVALS * intervalMs }

    private companion object {
        const val STALE_INTERVALS = 2
    }
}

/**
 * Each camera's latest picture from `latest.jpg`, kept in the view model so
 * turning the phone keeps it up rather than starting from a spinner, and so a
 * camera's tile can tell a screen reader its picture is out of date.
 */
class Snapshots(
    private val clock: () -> Long = System::currentTimeMillis,
    private val decode: suspend (ByteArray) -> ImageBitmap? = ::decodeFrame,
) {
    private val states = mutableStateMapOf<String, Snapshot>()

    operator fun get(camera: String): Snapshot = states[camera] ?: Snapshot()

    /** Fetches [camera]'s picture with [fetch] every [intervalMs] until cancelled. */
    suspend fun follow(camera: String, intervalMs: Long, fetch: suspend () -> ByteArray) {
        while (true) {
            refresh(camera, intervalMs, fetch)
            delay(intervalMs)
        }
    }

    /** One try; the previous picture stays up until the next one decodes. */
    suspend fun refresh(camera: String, intervalMs: Long, fetch: suspend () -> ByteArray) {
        val bitmap = try {
            decode(fetch())
        } catch (_: IOException) {
            null
        }
        val now = clock()
        val old = get(camera)
        states[camera] = if (bitmap != null) {
            Snapshot(bitmap, takenAt = now, checkedAt = now, failed = false, intervalMs = intervalMs)
        } else {
            old.copy(checkedAt = now, failed = true, intervalMs = intervalMs)
        }
    }

    /** Forgets every picture, for a new session. */
    fun reset() {
        states.clear()
    }
}

private suspend fun decodeFrame(bytes: ByteArray): ImageBitmap? = withContext(Dispatchers.Default) {
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
}

/** The signed-in session's [Snapshots]; null outside it, where each picture keeps its own. */
val LocalSnapshots = staticCompositionLocalOf<Snapshots?> { null }

/** "Offline, 2m": how a picture [staleMs] out of date is marked. */
internal fun offlineLabel(staleMs: Long): UiText {
    val seconds = staleMs / 1_000
    val age = when {
        seconds < 60 -> uiText(R.string.age_seconds, seconds)
        seconds < 3_600 -> uiText(R.string.age_minutes, seconds / 60)
        seconds < 86_400 -> uiText(R.string.age_hours, seconds / 3_600)
        else -> uiText(R.string.age_days, seconds / 86_400)
    }
    return uiText(R.string.picture_offline, age)
}
