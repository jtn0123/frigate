package com.jtn.frigateviewer.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.view.View
import android.widget.RemoteViews
import com.jtn.frigateviewer.MainActivity
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.container
import com.jtn.frigateviewer.data.ServerSettings
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * A home screen widget with one camera's latest picture and the alerts left to
 * review. It updates every half hour, when its refresh button is tapped and
 * when the app goes to the background; tapping the picture opens the camera.
 */
class CameraWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val pending = goAsync()
        scope.launch {
            try {
                update(context.applicationContext, ids)
            } finally {
                pending.finish()
            }
        }
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        WidgetChoices(context).forget(ids)
    }

    companion object {
        /** Extra naming the camera to open, for [MainActivity]. */
        const val EXTRA_CAMERA = "com.jtn.frigateviewer.camera"

        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        /** Asks every placed widget, or just [ids], to update. */
        fun requestUpdate(context: Context, ids: IntArray? = null) {
            val all = ids ?: AppWidgetManager.getInstance(context)
                .getAppWidgetIds(ComponentName(context, CameraWidget::class.java))
            if (all.isNotEmpty()) context.sendBroadcast(updateIntent(context, all))
        }

        private fun updateIntent(context: Context, ids: IntArray) =
            Intent(context, CameraWidget::class.java)
                .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)

        /** Loads and shows each of [ids]; a failure keeps the last picture and says so. */
        suspend fun update(context: Context, ids: IntArray) {
            val manager = AppWidgetManager.getInstance(context)
            val store = context.container.settingsStore
            val settings = store.settings.first()
            val session = context.container.resumeSession(settings, scope)
            val tunnelOn = store.tunnel.first()?.enabled == true
            val choices = WidgetChoices(context)
            val chosen = ids.associateWith { choices[it] }
            val wanted = chosen.mapNotNull { (id, choice) -> choice?.let { id to it } }
            // One load for every widget, bounded as a whole.
            val contents = session?.api?.widgetContents(wanted.map { it.second }, settings)
            val loaded = wanted.mapIndexed { i, (id, _) -> id to (contents?.get(i) ?: WidgetContent.SignedOut) }.toMap()
            chosen.forEach { (id, choice) ->
                val content = loaded[id]?.awayIf(tunnelOn)
                val views = render(context, id, choice, content, settings)
                if (isPartial(content, choices.shownSinceBoot(id))) {
                    manager.partiallyUpdateAppWidget(id, views)
                } else {
                    manager.updateAppWidget(id, views)
                    choices.markShown(id)
                }
            }
        }

        /**
         * A failure only changes the status line, keeping the last picture, but
         * Android ignores a partial update until the widget has had a full one,
         * so a widget not [shown] yet gets the failure as a full update.
         */
        internal fun isPartial(content: WidgetContent?, shown: Boolean): Boolean = content is WidgetContent.Failed && shown

        /**
         * The widget's views. With no [choice] it asks for a camera; a failed
         * [content] only changes the status line, so it is applied as a partial
         * update once the widget has had a full one.
         */
        fun render(
            context: Context,
            id: Int,
            choice: WidgetChoice?,
            content: WidgetContent?,
            settings: ServerSettings,
            now: Instant = Instant.now(),
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_camera)
            views.setOnClickPendingIntent(R.id.widget_refresh, refreshIntent(context, id))
            if (choice == null) {
                views.showMessage("Choose a camera")
                views.setOnClickPendingIntent(android.R.id.background, setupIntent(context, id))
                return views
            }
            views.setTextViewText(R.id.widget_label, choice.label)
            views.setOnClickPendingIntent(android.R.id.background, openIntent(context, id, choice.camera))
            when (content) {
                null, WidgetContent.SignedOut -> {
                    views.showMessage("Sign in to Frigate")
                    views.setTextViewText(R.id.widget_status, "")
                }
                is WidgetContent.Failed -> {
                    val status = if (content.away) "Away from home · Open Frigate to connect" else "Offline · ${content.message}"
                    views.setTextViewText(R.id.widget_status, status)
                    // Only seen before the first picture; afterwards the message is hidden behind it.
                    views.setTextViewText(R.id.widget_message, "Could not load the picture")
                }
                is WidgetContent.Ready -> views.showReady(content, settings, now)
            }
            return views
        }

        private fun RemoteViews.showReady(content: WidgetContent.Ready, settings: ServerSettings, now: Instant) {
            val frame = content.frame?.let(::decode)
            if (frame != null) {
                setImageViewBitmap(R.id.widget_frame, frame)
                setViewVisibility(R.id.widget_message, View.GONE)
            } else {
                setImageViewBitmap(R.id.widget_frame, null)
                showMessage(if (settings.appLock) "Picture hidden while the app is locked" else "No picture")
            }
            val toReview = content.toReview ?: 0
            setViewVisibility(R.id.widget_badge, if (toReview > 0) View.VISIBLE else View.GONE)
            setTextViewText(R.id.widget_badge, if (toReview > MAX_BADGE) "$MAX_BADGE+" else toReview.toString())
            setContentDescription(R.id.widget_badge, "$toReview alerts to review")
            setTextViewText(R.id.widget_status, "Updated ${clock.format(now.atZone(ZoneId.systemDefault()))}")
        }

        private fun RemoteViews.showMessage(text: String) {
            setViewVisibility(R.id.widget_message, View.VISIBLE)
            setTextViewText(R.id.widget_message, text)
        }

        /** RGB_565 halves the bitmap, which a widget sends to the launcher in one parcel. */
        private fun decode(bytes: ByteArray): Bitmap? =
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.RGB_565 })

        private fun refreshIntent(context: Context, id: Int): PendingIntent = PendingIntent.getBroadcast(
            context,
            id,
            updateIntent(context, intArrayOf(id)),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun openIntent(context: Context, id: Int, camera: String): PendingIntent = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java)
                .putExtra(EXTRA_CAMERA, camera)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun setupIntent(context: Context, id: Int): PendingIntent = PendingIntent.getActivity(
            context,
            id,
            Intent(context, WidgetSetupActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private val clock = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
    }
}
