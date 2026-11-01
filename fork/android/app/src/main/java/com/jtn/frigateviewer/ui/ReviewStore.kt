package com.jtn.frigateviewer.ui

import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Severity
import com.jtn.frigateviewer.data.map
import com.jtn.frigateviewer.data.markReviewed
import com.jtn.frigateviewer.data.reviews
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Review items from the last 24 hours. Everything is fetched at once and the
 * filters apply locally, so switching them is instant. It holds no Android
 * types, so it is unit tested on the JVM.
 */
class ReviewStore(
    private val scope: CoroutineScope,
    private val limit: Int = FrigateApi.REVIEW_LIMIT,
    private val onSessionLost: (String?) -> Unit,
) {
    var reviews by mutableStateOf<Remote<List<ReviewItem>>>(Remote.Loading)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var severity by mutableStateOf(Severity.ALERT)
    var cameraFilter by mutableStateOf<String?>(null)

    /** A one-time notice for the user, cleared with [messageShown]. */
    var message by mutableStateOf<ReviewNotice?>(null)
        private set

    private val all: List<ReviewItem>
        get() = (reviews as? Remote.Ready)?.value.orEmpty()

    val filtered by derivedStateOf {
        all.filter { item ->
            (severity.apiValue == null || item.severity == severity.apiValue) &&
                (cameraFilter == null || item.camera == cameraFilter)
        }
    }

    val unreviewedAlerts by derivedStateOf { all.count { it.isAlert && !it.reviewed } }

    /** The server had at least as many items as were asked for, so older ones may be missing. */
    val capped by derivedStateOf { all.size >= limit }

    fun byId(id: String): ReviewItem? = all.firstOrNull { it.id == id }

    fun forCamera(camera: String): List<ReviewItem> = all.filter { it.camera == camera }

    /** The running refresh, cancelled by [reset]. */
    private var running: Job? = null

    /** Counts [reset]s, so a refresh from before one leaves the new session's list and flag alone. */
    private var generation = 0

    /** Forgets the list and stops a refresh still running, for a new session. */
    fun reset() {
        generation++
        running?.cancel()
        running = null
        refreshing = false
        reviews = Remote.Loading
    }

    /** Fetches the list; null when a refresh is already running. */
    fun refresh(api: FrigateApi): Job? {
        if (refreshing) return null
        refreshing = true
        val started = generation
        return scope.launch {
            try {
                val result = loadRemote(onSessionLost) { api.reviews(limit = limit) }
                // Keep showing the last good list when a background refresh fails.
                if (started == generation && (result is Remote.Ready || reviews !is Remote.Ready)) reviews = result
            } finally {
                if (started == generation) refreshing = false
            }
        }.also { running = it }
    }

    /**
     * Adds or updates an item the server just reported. An update keeps the
     * reviewed state shown here, since the feed's copy does not carry it.
     */
    fun upsert(item: ReviewItem) {
        reviews = reviews.map { list ->
            val old = list.firstOrNull { it.id == item.id }
            if (old == null) {
                (listOf(item) + list).sortedByDescending { it.startTime }
            } else {
                list.map { if (it.id == item.id) item.copy(reviewed = old.reviewed) else it }
            }
        }
    }

    /**
     * Marks [items] reviewed here at once and on the server in the background;
     * null when none needed it. If the server refuses, they are shown as
     * unreviewed again and [message] says so.
     */
    fun markReviewed(api: FrigateApi, items: List<ReviewItem>, undoable: Boolean = false): Job? {
        val ids = items.filterNot { it.reviewed }.map { it.id }.toSet()
        if (ids.isEmpty()) return null
        return mark(api, ids, reviewed = true, undoable = undoable)
    }

    /** Puts back what [notice] marked, here at once and on the server in the background. */
    fun undo(api: FrigateApi, notice: ReviewNotice): Job? =
        if (notice.undoIds.isEmpty()) null else mark(api, notice.undoIds, reviewed = false, undoable = false)

    private fun mark(api: FrigateApi, ids: Set<String>, reviewed: Boolean, undoable: Boolean): Job {
        setReviewed(ids, reviewed)
        return scope.launch {
            val result = loadRemote(onSessionLost) { api.markReviewed(ids.toList(), reviewed) }
            val what = if (ids.size == 1) "this item" else "${ids.size} items"
            message = when {
                result is Remote.Failed -> {
                    setReviewed(ids, !reviewed)
                    ReviewNotice("Could not mark $what ${if (reviewed) "reviewed" else "unreviewed"} (${result.message})")
                }
                undoable -> ReviewNotice(if (ids.size == 1) "Marked reviewed" else "Marked $what reviewed", undoIds = ids)
                else -> message
            }
        }
    }

    /**
     * Marks [item] reviewed because it was opened, when [settings] ask for that:
     * only with review tracking and "mark reviewed when opened" both on, so
     * turning tracking off leaves the server alone.
     */
    fun opened(api: FrigateApi, item: ReviewItem, settings: ServerSettings): Job? =
        if (settings.trackReviews && settings.markReviewedOnOpen) markReviewed(api, listOf(item)) else null

    fun messageShown() {
        message = null
    }

    private fun setReviewed(ids: Set<String>, reviewed: Boolean) {
        reviews = reviews.map { list -> list.map { if (it.id in ids) it.copy(reviewed = reviewed) else it } }
    }
}

/** Something to tell the user about marking; with [undoIds], an Undo puts those items back. */
data class ReviewNotice(val text: String, val undoIds: Set<String> = emptySet())

/** The items just older and just newer than [item] in [list], which is newest first. */
fun adjacentReviews(list: List<ReviewItem>, item: ReviewItem): Pair<ReviewItem?, ReviewItem?> {
    val index = list.indexOfFirst { it.id == item.id }
    if (index < 0) return null to null
    return list.getOrNull(index + 1) to list.getOrNull(index - 1)
}
