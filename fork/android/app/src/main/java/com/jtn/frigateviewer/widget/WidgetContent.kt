package com.jtn.frigateviewer.widget

import android.content.Context
import android.provider.Settings
import androidx.core.content.edit
import com.jtn.frigateviewer.data.AuthException
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Severity
import com.jtn.frigateviewer.data.reviews
import com.jtn.frigateviewer.ui.describeError
import java.io.IOException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull

/** The camera a widget shows, with its label kept so the widget can name it while offline. */
data class WidgetChoice(val camera: String, val label: String)

/** What a camera widget shows after an update. */
sealed interface WidgetContent {
    /** There is no signed-in server to ask. */
    data object SignedOut : WidgetContent

    /** [frame] is null while the app lock is on; [toReview] is null when reviews are not tracked. */
    class Ready(val frame: ByteArray?, val toReview: Int?) : WidgetContent

    /** [away] when the tunnel is set up: the server is only reached through it, which the widget cannot start. */
    data class Failed(val message: String, val away: Boolean = false) : WidgetContent
}

/** A failure while a tunnel is set up and on most likely means the phone is away from home. */
internal fun WidgetContent.awayIf(tunnelOn: Boolean): WidgetContent =
    if (this is WidgetContent.Failed && tunnelOn) copy(away = true) else this

/**
 * What each of [choices] shows: its camera's latest frame, and how many alerts
 * are left to review, as the app counts them. The count is the same for every
 * widget, so it is fetched once, and only as far as the badge goes; the frames
 * are fetched side by side. All of it must finish within [timeoutMs], since
 * Android allows a widget update about ten seconds in all; what does not, fails.
 * The app lock keeps the pictures off the home screen.
 */
suspend fun FrigateApi.widgetContents(
    choices: List<WidgetChoice>,
    settings: ServerSettings,
    timeoutMs: Long = UPDATE_TIMEOUT_MS,
): List<WidgetContent> = if (choices.isEmpty()) {
    emptyList()
} else {
    withTimeoutOrNull(timeoutMs) { loadContents(choices, settings) }
        ?: choices.map { WidgetContent.Failed("Could not connect to the server") }
}

private suspend fun FrigateApi.loadContents(choices: List<WidgetChoice>, settings: ServerSettings): List<WidgetContent> =
    coroutineScope {
        val toReview = async { attempt { if (settings.trackReviews) alertsToReview() else null } }
        val frames = choices.map { choice ->
            async { attempt { if (settings.appLock) null else latestFrame(choice.camera, FRAME_HEIGHT) } }
        }
        val count = toReview.await()
        frames.awaitAll().map { frame ->
            frame.failure ?: count.failure ?: WidgetContent.Ready(frame.value, count.value)
        }
    }

/** Unreviewed alerts of the last 24 hours, up to one more than the badge shows. */
private suspend fun FrigateApi.alertsToReview(): Int =
    reviews(Severity.ALERT, limit = MAX_BADGE + 1, reviewed = false).count { !it.reviewed }

/** A value, or what a widget shows instead when it could not be loaded. */
private class Loaded<T>(val value: T?, val failure: WidgetContent? = null)

private suspend fun <T> attempt(block: suspend () -> T): Loaded<T> = try {
    Loaded(block())
} catch (_: AuthException) {
    Loaded(null, WidgetContent.SignedOut)
} catch (e: IOException) {
    Loaded(null, WidgetContent.Failed(describeError(e)))
} catch (e: IllegalArgumentException) {
    Loaded(null, WidgetContent.Failed(describeError(e)))
}

/** A broadcast receiver has about ten seconds; the HTTP client's own timeouts are longer. */
internal const val UPDATE_TIMEOUT_MS = 8_000L

/** The badge shows up to this many alerts, then "99+". */
internal const val MAX_BADGE = 99

/** Small enough for a widget bitmap and a quick download. */
private const val FRAME_HEIGHT = 360

/** Each widget's camera, kept until the widget is removed. */
class WidgetChoices(context: Context) {
    private val prefs = context.getSharedPreferences("widgets", Context.MODE_PRIVATE)
    private val resolver = context.contentResolver

    /** Counts the phone's starts; the launcher's copy of every widget is gone after one. */
    private val boot: Int get() = Settings.Global.getInt(resolver, Settings.Global.BOOT_COUNT, 0)

    /**
     * Whether widget [id] has had a full update since the phone started. Until
     * it has, Android ignores partial updates, so the next one has to be full.
     */
    fun shownSinceBoot(id: Int): Boolean = prefs.getInt("boot_$id", -1) == boot

    /** Notes that widget [id] just had a full update. */
    fun markShown(id: Int) {
        prefs.edit { putInt("boot_$id", boot) }
    }

    operator fun get(id: Int): WidgetChoice? {
        val camera = prefs.getString("camera_$id", null) ?: return null
        return WidgetChoice(camera, prefs.getString("label_$id", null) ?: camera)
    }

    operator fun set(id: Int, choice: WidgetChoice) {
        prefs.edit { putString("camera_$id", choice.camera).putString("label_$id", choice.label) }
    }

    fun forget(ids: IntArray) {
        prefs.edit { ids.forEach { remove("camera_$it").remove("label_$it").remove("boot_$it") } }
    }
}
