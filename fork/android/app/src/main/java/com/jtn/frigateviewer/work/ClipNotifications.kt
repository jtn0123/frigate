package com.jtn.frigateviewer.work

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.work.ForegroundInfo
import com.jtn.frigateviewer.MainActivity
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.ClipRequest
import com.jtn.frigateviewer.data.Failure
import com.jtn.frigateviewer.ui.text

/**
 * The notifications of a clip saving in the background: one while it saves,
 * and one when it is saved, which opens it, or could not be. Without the
 * permission to post them (Android 13 and later), only the progress shown by
 * the foreground service remains, and the app's screens still say how it went.
 */
internal class ClipNotifications(private val context: Context) {
    private val manager = NotificationManagerCompat.from(context)

    /** Whether notifications may be posted: always before Android 13, once allowed after. */
    val permitted: Boolean
        get() = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Whether the user can still be asked to allow them. */
    val askable: Boolean get() = !permitted

    /** The ongoing notification of [request] being prepared or [downloading], as a data sync foreground service's. */
    fun progress(request: ClipRequest, downloading: Boolean): ForegroundInfo {
        val notification = builder(request)
            .setContentText(context.getString(if (downloading) R.string.clip_saving else R.string.clip_preparing))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(0, 0, true)
            .setContentIntent(openApp())
            .build()
        return ForegroundInfo(progressId(request), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    /** Says [request]'s clip was saved at [uri]; tapping it plays the clip. */
    fun saved(request: ClipRequest, uri: String) {
        val play = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri.toUri(), "video/mp4")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        val tap = PendingIntent.getActivity(
            context,
            progressId(request),
            play,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        post(request, builder(request).setContentText(context.getString(R.string.clip_saved)).setContentIntent(tap).build())
    }

    /** Says why [request]'s clip could not be saved; tapping it opens the app. */
    fun failed(request: ClipRequest, failure: Failure) {
        val reason = context.getString(R.string.clip_save_failed, failure.text.resolve(context.resources))
        post(
            request,
            builder(request)
                .setContentText(reason)
                .setStyle(NotificationCompat.BigTextStyle().bigText(reason))
                .setContentIntent(openApp())
                .build(),
        )
    }

    private fun builder(request: ClipRequest): NotificationCompat.Builder {
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName(context.getString(R.string.clip_channel_name))
                .setDescription(context.getString(R.string.clip_channel_description))
                .build(),
        )
        return NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification_clip)
            .setContentTitle(request.name)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setAutoCancel(true)
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** Posts [request]'s result, in place of an earlier one for the same item; nothing when notifications are not allowed. */
    private fun post(request: ClipRequest, notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        manager.notify(request.itemId, RESULT_ID, notification)
    }

    /** Each item's progress has its own, so two clips saving at once show both. */
    private fun progressId(request: ClipRequest): Int = PROGRESS_IDS + (request.itemId.hashCode() and ID_MASK)

    companion object {
        const val CHANNEL = "clips"
        const val RESULT_ID = 1
        private const val PROGRESS_IDS = 1_000
        private const val ID_MASK = 0xFFFF
    }
}
