package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.reviews
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Fetching a [ReviewStore]'s list, read with [held] and replaced with [show].
 *
 * Two ways: [refresh] takes the whole list, and [refreshRecent] only what
 * changed lately, which is all a reconnect needs on a flaky network. A recent
 * fetch asks for items still going on or ended after the newest one held,
 * less [OVERLAP_SECONDS] (the server's own times, so the phone's clock does
 * not matter), with a limit of [recentLimit]. That brings every new item and
 * every change to one still going on, which are put in by ID with the
 * server's copy winning; the rest are kept as they are, and items that ended
 * more than 24 hours ago are dropped.
 *
 * What a recent fetch cannot see is an older item deleted on the server, or
 * marked reviewed or unreviewed elsewhere. Those wait for the next whole
 * fetch, which replaces the list: pull to refresh and a new session always
 * take one, and a recent fetch becomes one when the last whole one is
 * [FULL_EVERY_MS] old, when nothing is held yet, or when its answer is a full
 * page (more may have changed than it holds).
 */
internal class ReviewFetches(
    private val scope: CoroutineScope,
    private val limit: Int,
    private val recentLimit: Int,
    private val clock: () -> Long,
    private val onSessionLost: (String?) -> Unit,
    private val held: () -> Remote<List<ReviewItem>>,
    private val show: (Remote<List<ReviewItem>>) -> Unit,
) {
    /** A whole fetch is running. */
    var refreshing by mutableStateOf(false)
        private set

    /** The running whole fetch, cancelled by [reset]. */
    private var running: Job? = null

    /** The waiting or running recent fetch. */
    private var catchingUp: Job? = null

    /** Another [refreshRecent] came while one was already asking, so it asks once more after. */
    private var again = false

    /** When the last fetch of either kind started, and the last whole one that worked, by [clock]. */
    private var lastFetchAt: Long? = null
    private var lastFullAt: Long? = null

    /** Counts [reset]s, so a fetch from before one leaves the new session's list and flag alone. */
    private var generation = 0

    fun reset() {
        generation++
        running?.cancel()
        running = null
        catchingUp?.cancel()
        catchingUp = null
        again = false
        lastFetchAt = null
        lastFullAt = null
        refreshing = false
    }

    /** Fetches the whole list; null when a whole fetch is already running. */
    fun refresh(api: FrigateApi): Job? {
        if (refreshing) return null
        // Its answer would be older than this one's.
        catchingUp?.cancel()
        catchingUp = null
        again = false
        refreshing = true
        val started = generation
        return scope.launch { fetchAll(api, started) }.also { running = it }
    }

    /**
     * Catches up with what changed lately, after the live feed reconnects,
     * the route to the server changes, or the fallback poll. Calls closer
     * than [MIN_GAP_MS] apart are folded into one, run when the gap is up, so
     * a run of reconnects asks once; one that comes while a fetch is asking
     * asks once more after it, since something may have changed after it
     * was sent. Null when one is already waiting or asking.
     */
    fun refreshRecent(api: FrigateApi): Job? {
        if (catchingUp?.isActive == true) {
            again = true
            return null
        }
        val started = generation
        return scope.launch {
            var wait = lastFetchAt?.let { it + MIN_GAP_MS - clock() } ?: 0
            do {
                if (wait > 0) delay(wait)
                // Asked for before this point, so covered by this fetch.
                again = false
                catchUp(api, started)
                wait = MIN_GAP_MS
            } while (again && started == generation)
        }.also { catchingUp = it }
    }

    private suspend fun catchUp(api: FrigateApi, started: Int) {
        val list = (held() as? Remote.Ready)?.value
        val newest = list?.maxOfOrNull { it.startTime }
        val fullDue = lastFullAt.let { it == null || clock() - it >= FULL_EVERY_MS }
        val whole = newest == null || fullDue
        val fresh = if (whole) null else fetchRecent(api, after = newest.toLong() - OVERLAP_SECONDS)
        when {
            started != generation -> Unit
            whole || (fresh != null && fresh.size >= recentLimit) -> {
                // Nothing to catch up from, the last whole list is old, or more changed than one page holds.
                if (!refreshing) {
                    refreshing = true
                    fetchAll(api, started)
                }
            }
            // A failure keeps the list as it is; the next catch-up or poll tries again.
            fresh != null -> show(held().map { merge(it, fresh) })
        }
    }

    /** Items still going on or ended after [after], or null when the request failed. */
    private suspend fun fetchRecent(api: FrigateApi, after: Long): List<ReviewItem>? {
        lastFetchAt = clock()
        return (loadRemote(onSessionLost) { api.reviews(limit = recentLimit, after = after) } as? Remote.Ready)?.value
    }

    /** [current] with [fresh] put in by ID, the server's copy winning, and items gone past the 24 hours dropped. */
    private fun merge(current: List<ReviewItem>, fresh: List<ReviewItem>): List<ReviewItem> {
        val freshById = fresh.associateBy { it.id }
        val heldIds = current.mapTo(HashSet()) { it.id }
        val cutoff = clock() / 1000 - DAY_SECONDS
        return (current.map { freshById[it.id] ?: it } + fresh.filter { it.id !in heldIds })
            .filter { item -> item.endTime.let { it == null || it > cutoff } }
            .sortedByDescending { it.startTime }
    }

    /** Runs a whole fetch; [refreshing] is already set. */
    private suspend fun fetchAll(api: FrigateApi, started: Int) {
        try {
            val at = clock()
            lastFetchAt = at
            val result = loadRemote(onSessionLost) { api.reviews(limit = limit) }
            if (started != generation) return
            if (result is Remote.Ready) {
                lastFullAt = at
                show(result)
            } else if (held() !is Remote.Ready) {
                // Keep showing the last good list when a background refresh fails.
                show(result)
            }
        } finally {
            if (started == generation) refreshing = false
        }
    }
}

/** Fetches closer together than this are folded into one. */
internal const val MIN_GAP_MS = 30_000L

/** A recent fetch takes the whole list instead once the last whole one is this old. */
internal const val FULL_EVERY_MS = 5 * 60_000L

/** How far before the newest item held a recent fetch starts, for items that overlap. */
internal const val OVERLAP_SECONDS = 60L

/** At most this many items in a recent fetch; one this full may have missed some, so a whole fetch follows. */
internal const val RECENT_LIMIT = 200

private const val DAY_SECONDS = 86_400L
