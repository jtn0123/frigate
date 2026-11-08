package com.jtn.frigateviewer.work

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.await
import androidx.work.workDataOf
import com.jtn.frigateviewer.container
import com.jtn.frigateviewer.data.ClipRequest
import com.jtn.frigateviewer.data.Failure
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.MediaFiles
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.remote
import com.jtn.frigateviewer.data.saveClip
import com.jtn.frigateviewer.ui.ClipJobs
import com.jtn.frigateviewer.ui.ClipState
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.transformWhile

/**
 * Saves one clip in the background, so it finishes after the app is left: as
 * a foreground service (data sync) with a progress notification where Android
 * allows one, then a notification saying it was saved, or why not. It signs in
 * from the saved settings, as the widget does.
 */
class ClipWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val notifications = ClipNotifications(context)

    /** Export IDs this work started, so work stopped and started again waits for the same export. */
    private val exports: SharedPreferences = context.getSharedPreferences(EXPORTS, Context.MODE_PRIVATE)

    override suspend fun doWork(): Result {
        val request = clipRequestOf(inputData) ?: return Result.failure()
        promote(request, downloading = false)
        val container = applicationContext.container
        // Only a test's container has nowhere to save.
        val media = container.mediaFiles ?: return Result.failure()
        // The tunnel stays up while the clip saves, though the app has gone to the background.
        val outcome = container.remoteAccess?.holds?.hold().use {
            coroutineScope {
                val session = container.resumeSession(container.settingsStore.settings.first(), this)
                if (session == null) {
                    Remote.Failed(Failure.SessionExpired)
                } else {
                    remote { save(session.api, media, request) }
                }
            }
        }
        exports.edit { remove(id.toString()) }
        return finished(request, outcome)
    }

    private suspend fun save(api: FrigateApi, media: MediaFiles, request: ClipRequest): String = api.saveClip(
        media,
        request,
        exportId = exports.getString(id.toString(), null),
        onStarted = { export -> exports.edit { putString(id.toString(), export) } },
        onDownloading = {
            setProgress(workDataOf(KEY_STAGE to STAGE_DOWNLOADING))
            promote(request, downloading = true)
        },
    )

    /** Says how it went, and gives the clip's URI, or the failure, to the screens. */
    private fun finished(request: ClipRequest, outcome: Remote<String>): Result = when (outcome) {
        is Remote.Ready -> {
            notifications.saved(request, outcome.value)
            Result.success(workDataOf(KEY_URI to outcome.value))
        }
        is Remote.Failed -> {
            notifications.failed(request, outcome.failure)
            Result.failure(outcome.failure.toData())
        }
        Remote.Loading -> Result.failure()
    }

    /**
     * Runs on as a foreground service with the progress notification. Android
     * refuses one started from the background; the work then goes on as it is.
     */
    private suspend fun promote(request: ClipRequest, downloading: Boolean) {
        try {
            setForeground(notifications.progress(request, downloading))
        } catch (_: IllegalStateException) {
            // Not allowed from the background, as on Android 12 and later: saving goes on without it.
        }
    }

    /** Asked for before Android 12, where expedited work runs as a foreground service. */
    override suspend fun getForegroundInfo(): ForegroundInfo {
        val request = clipRequestOf(inputData) ?: ClipRequest("", "", 0, 0, "")
        return notifications.progress(request, downloading = false)
    }

    internal companion object {
        const val TAG = "clip"
        const val KEY_URI = "uri"
        const val KEY_STAGE = "stage"
        const val STAGE_DOWNLOADING = "downloading"
        const val EXPORTS = "clip_exports"
    }
}

/**
 * Saves clips with [ClipWorker]: one job per review item, kept if it is
 * already underway, and followed through WorkManager. The job, not the
 * collecting screen, owns the save, so it goes on after the app is left.
 */
class WorkClipJobs(private val context: Context) : ClipJobs {
    private val manager by lazy { WorkManager.getInstance(context) }

    override val wantsNotifications: Boolean get() = ClipNotifications(context).askable

    override fun save(api: FrigateApi, request: ClipRequest): Flow<ClipState?> = flow {
        val name = uniqueName(request.itemId)
        val work = OneTimeWorkRequestBuilder<ClipWorker>()
            .setInputData(request.toData())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .addTag(ClipWorker.TAG)
            .build()
        manager.enqueueUniqueWork(name, ExistingWorkPolicy.KEEP, work).await()
        val followed = manager.getWorkInfosForUniqueWorkFlow(name).mapNotNull { it.lastOrNull() }.transformWhile { info ->
            emit(clipStateOf(info))
            !info.state.isFinished
        }
        // WorkManager reports each change to the work; the screens need only those of its state.
        emitAll(followed.distinctUntilChanged())
    }

    override fun cancelAll() {
        manager.cancelAllWorkByTag(ClipWorker.TAG)
    }

    private companion object {
        fun uniqueName(itemId: String) = "clip-$itemId"

        /** How work [info] is going; null once it was cancelled. */
        fun clipStateOf(info: WorkInfo): ClipState? = when (info.state) {
            WorkInfo.State.ENQUEUED, WorkInfo.State.BLOCKED -> ClipState.Preparing
            WorkInfo.State.RUNNING -> {
                val downloading = info.progress.getString(ClipWorker.KEY_STAGE) == ClipWorker.STAGE_DOWNLOADING
                if (downloading) ClipState.Downloading else ClipState.Preparing
            }
            WorkInfo.State.SUCCEEDED -> ClipState.Saved(info.outputData.getString(ClipWorker.KEY_URI).orEmpty())
            WorkInfo.State.FAILED -> ClipState.Failed(failureOf(info.outputData))
            WorkInfo.State.CANCELLED -> null
        }
    }
}

private const val KEY_ITEM = "item"
private const val KEY_CAMERA = "camera"
private const val KEY_START = "start"
private const val KEY_END = "end"
private const val KEY_NAME = "name"

internal fun ClipRequest.toData(): Data =
    workDataOf(KEY_ITEM to itemId, KEY_CAMERA to camera, KEY_START to start, KEY_END to end, KEY_NAME to name)

internal fun clipRequestOf(data: Data): ClipRequest? {
    val item = data.getString(KEY_ITEM) ?: return null
    val camera = data.getString(KEY_CAMERA) ?: return null
    return ClipRequest(item, camera, data.getLong(KEY_START, 0), data.getLong(KEY_END, 0), data.getString(KEY_NAME).orEmpty())
}

private const val KEY_FAILURE = "failure"
private const val KEY_CODE = "code"
private const val KEY_PATH = "path"
private const val KEY_DETAIL = "detail"

/** The failures that carry nothing, by name. */
private val plainFailures: Map<String, Failure> = listOf(
    Failure.SessionExpired,
    Failure.ServerNotFound,
    Failure.Offline,
    Failure.Timeout,
    Failure.Forbidden,
    Failure.BadResponse,
    Failure.InvalidAddress,
    Failure.CertificateChanged,
    Failure.CertificateUntrusted,
    Failure.CertificateRejected,
).associateBy { it.toString() }

/** [Failure] as work output, for the screen following the work to say what happened. */
internal fun Failure.toData(): Data = when (this) {
    is Failure.Http -> workDataOf(KEY_FAILURE to "Http", KEY_CODE to code, KEY_PATH to path)
    is Failure.Other -> workDataOf(KEY_FAILURE to "Other", KEY_DETAIL to detail)
    else -> workDataOf(KEY_FAILURE to toString())
}

internal fun failureOf(data: Data): Failure = when (val kind = data.getString(KEY_FAILURE)) {
    "Http" -> Failure.Http(data.getInt(KEY_CODE, 0), data.getString(KEY_PATH))
    "Other" -> Failure.Other(data.getString(KEY_DETAIL).orEmpty())
    else -> plainFailures[kind] ?: Failure.Other("")
}
