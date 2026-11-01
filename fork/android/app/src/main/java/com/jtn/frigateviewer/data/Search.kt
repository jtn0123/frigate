package com.jtn.frigateviewer.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl

/** What to look for in the server's whole history; times are epoch seconds. */
data class SearchFilter(
    val after: Long,
    val before: Long,
    val cameras: Set<String> = emptySet(),
    val labels: Set<String> = emptySet(),
    /** Words describing what to find, matched by Frigate's semantic search. */
    val query: String = "",
)

/** One object Frigate tracked, from `/api/events`. */
@Serializable
data class TrackedObject(
    val id: String,
    val camera: String,
    val label: String,
    @SerialName("start_time") val startTime: Double,
    @SerialName("end_time") val endTime: Double? = null,
    val data: TrackedObjectData = TrackedObjectData(),
)

@Serializable
data class TrackedObjectData(
    /** Written by a generative AI model when the server has one set up. */
    val description: String? = null,
)

/** The most results one search shows; narrower filters reach further back. */
const val SEARCH_LIMIT = 200

/** Review items matching [filter], newest first; the server lists alerts first. */
suspend fun FrigateApi.searchReviews(filter: SearchFilter): List<ReviewItem> {
    val url = filtered("api/review", filter).addQueryParameter("limit", SEARCH_LIMIT.toString()).build()
    return getBody(url) { json.decodeFromString<List<ReviewItem>>(it).sortedByDescending { item -> item.startTime } }
}

/** Tracked objects whose picture or description matches [SearchFilter.query]. */
suspend fun FrigateApi.searchDescriptions(filter: SearchFilter): List<TrackedObject> {
    val url = filtered("api/events/search", filter)
        .addQueryParameter("query", filter.query)
        .addQueryParameter("search_type", "thumbnail,description")
        .addQueryParameter("limit", SEARCH_LIMIT.toString())
        .build()
    return getJson(url)
}

/** One review item by its ID, from any time. */
suspend fun FrigateApi.review(id: String): ReviewItem = getJson(url("api/review/$id"))

/** The review item an object was part of. */
suspend fun FrigateApi.reviewForObject(id: String): ReviewItem = getJson(url("api/review/event/$id"))

/** Every label the server has tracked, to filter by. */
suspend fun FrigateApi.labels(): List<String> = getBody(url("api/labels")) { json.decodeFromString<List<String>>(it).sorted() }

fun FrigateApi.objectThumbnailUrl(id: String): String = url("api/events/$id/thumbnail.webp").toString()

private fun FrigateApi.filtered(path: String, filter: SearchFilter): HttpUrl.Builder = url(path).newBuilder()
    .addQueryParameter("after", filter.after.toString())
    .addQueryParameter("before", filter.before.toString())
    .apply { if (filter.cameras.isNotEmpty()) addQueryParameter("cameras", filter.cameras.sorted().joinToString(",")) }
    .apply { if (filter.labels.isNotEmpty()) addQueryParameter("labels", filter.labels.sorted().joinToString(",")) }
