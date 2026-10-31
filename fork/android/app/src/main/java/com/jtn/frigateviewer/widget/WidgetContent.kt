package com.jtn.frigateviewer.widget

import android.content.Context
import androidx.core.content.edit
import com.jtn.frigateviewer.data.AuthException
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Severity
import com.jtn.frigateviewer.data.reviews
import com.jtn.frigateviewer.ui.describeError
import java.io.IOException

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
 * The latest frame of [choice] and how many alerts are left to review, as the
 * app counts them. The app lock keeps the picture off the home screen.
 */
suspend fun FrigateApi.widgetContent(choice: WidgetChoice, settings: ServerSettings): WidgetContent = try {
    val frame = if (settings.appLock) null else latestFrame(choice.camera, FRAME_HEIGHT)
    val toReview = if (settings.trackReviews) reviews(Severity.ALERT).count { !it.reviewed } else null
    WidgetContent.Ready(frame, toReview)
} catch (_: AuthException) {
    WidgetContent.SignedOut
} catch (e: IOException) {
    WidgetContent.Failed(describeError(e))
} catch (e: IllegalArgumentException) {
    WidgetContent.Failed(describeError(e))
}

/** Small enough for a widget bitmap and a quick download. */
private const val FRAME_HEIGHT = 360

/** Each widget's camera, kept until the widget is removed. */
class WidgetChoices(context: Context) {
    private val prefs = context.getSharedPreferences("widgets", Context.MODE_PRIVATE)

    operator fun get(id: Int): WidgetChoice? {
        val camera = prefs.getString("camera_$id", null) ?: return null
        return WidgetChoice(camera, prefs.getString("label_$id", null) ?: camera)
    }

    operator fun set(id: Int, choice: WidgetChoice) {
        prefs.edit { putString("camera_$id", choice.camera).putString("label_$id", choice.label) }
    }

    fun forget(ids: IntArray) {
        prefs.edit { ids.forEach { remove("camera_$it").remove("label_$it") } }
    }
}
