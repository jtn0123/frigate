package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.SEARCH_LIMIT
import com.jtn.frigateviewer.data.SearchFilter
import com.jtn.frigateviewer.data.TrackedObject
import com.jtn.frigateviewer.data.labels
import com.jtn.frigateviewer.data.reviewForObject
import com.jtn.frigateviewer.data.searchDescriptions
import com.jtn.frigateviewer.data.searchReviews
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** How far back to search. */
enum class SearchRange(val label: String) {
    TODAY("Today"),
    YESTERDAY("Yesterday"),
    WEEK("Last 7 days"),
    MONTH("Last 30 days"),
    ANY("Any time"),
    CUSTOM("Dates…"),
}

/** Everything the user chose; a new value runs a new search. */
data class SearchInputs(
    val range: SearchRange = SearchRange.WEEK,
    /** The days picked for [SearchRange.CUSTOM], both included. */
    val from: LocalDate? = null,
    val to: LocalDate? = null,
    val cameras: Set<String> = emptySet(),
    val labels: Set<String> = emptySet(),
    val query: String = "",
) {
    /** The filter these inputs mean at [now]. */
    fun filter(now: Instant, zone: ZoneId): SearchFilter {
        val today = now.atZone(zone).toLocalDate()
        fun start(day: LocalDate) = day.atStartOfDay(zone).toEpochSecond()
        val end = now.epochSecond
        val (after, before) = when (range) {
            SearchRange.TODAY -> start(today) to end
            SearchRange.YESTERDAY -> start(today.minusDays(1)) to start(today)
            SearchRange.WEEK -> end - Duration.ofDays(WEEK_DAYS).seconds to end
            SearchRange.MONTH -> end - Duration.ofDays(MONTH_DAYS).seconds to end
            SearchRange.ANY -> 0L to end
            SearchRange.CUSTOM -> start(from ?: today) to start((to ?: from ?: today).plusDays(1))
        }
        return SearchFilter(after, before, cameras, labels, query.trim())
    }
}

/** Review items, or with a description the objects that match it. */
data class SearchHits(val reviews: List<ReviewItem> = emptyList(), val objects: List<TrackedObject> = emptyList()) {
    val capped: Boolean get() = reviews.size >= SEARCH_LIMIT || objects.size >= SEARCH_LIMIT
    val isEmpty: Boolean get() = reviews.isEmpty() && objects.isEmpty()
}

/**
 * Searching the server's whole history by date, camera, label and, with
 * semantic search on, a description. Results stay while one is opened.
 */
class ReviewSearch(private val scope: CoroutineScope, private val onSessionLost: (String?) -> Unit) {
    var inputs by mutableStateOf(SearchInputs())
    var results by mutableStateOf<Remote<SearchHits>>(Remote.Loading)
        private set
    var labels by mutableStateOf<List<String>>(emptyList())
        private set

    /** A one-time message, such as an object whose recording is gone; cleared with [noticeShown]. */
    var notice by mutableStateOf<String?>(null)
        private set

    private var searched: SearchInputs? = null
    private var running: Job? = null

    /** Searches for the current [inputs], unless their results are already shown. */
    fun run(api: FrigateApi, force: Boolean = false, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Job? {
        val current = inputs
        if (!force && current == searched && results !is Remote.Failed) return null
        searched = current
        running?.cancel()
        results = Remote.Loading
        val filter = current.filter(now, zone)
        return scope.launch {
            results = loadRemote(onSessionLost) {
                if (filter.query.isEmpty()) {
                    SearchHits(
                        reviews = api.searchReviews(filter),
                    )
                } else {
                    SearchHits(objects = api.searchDescriptions(filter))
                }
            }
        }.also { running = it }
    }

    fun loadLabels(api: FrigateApi): Job? {
        if (labels.isNotEmpty()) return null
        return scope.launch {
            (loadRemote(onSessionLost) { api.labels() } as? Remote.Ready)?.let { labels = it.value }
        }
    }

    /** Finds the review item [found] belongs to and hands it to [open]. */
    fun openObject(api: FrigateApi, found: TrackedObject, open: (ReviewItem) -> Unit): Job = scope.launch {
        when (val review = loadRemote(onSessionLost) { api.reviewForObject(found.id) }) {
            is Remote.Ready -> open(review.value)
            is Remote.Failed -> notice = "Could not open it (${review.message})"
            Remote.Loading -> Unit
        }
    }

    fun noticeShown() {
        notice = null
    }

    fun reset() {
        running?.cancel()
        inputs = SearchInputs()
        results = Remote.Loading
        labels = emptyList()
        searched = null
        notice = null
    }
}

private const val WEEK_DAYS = 7L
private const val MONTH_DAYS = 30L
