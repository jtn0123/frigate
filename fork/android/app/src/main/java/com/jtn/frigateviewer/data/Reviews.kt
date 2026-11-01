package com.jtn.frigateviewer.data

import com.jtn.frigateviewer.data.FrigateApi.Companion.JSON
import com.jtn.frigateviewer.data.FrigateApi.Companion.REVIEW_LIMIT
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The review items of the last [hours], newest first. `/api/review` lists alerts
 * before detections (so its limit keeps alerts), which this undoes for the day lists.
 */
suspend fun FrigateApi.reviews(
    severity: Severity = Severity.ALL,
    camera: String? = null,
    hours: Int = 24,
    limit: Int = REVIEW_LIMIT,
): List<ReviewItem> {
    val after = System.currentTimeMillis() / 1000 - hours * 3600L
    val url = base.newBuilder().addPathSegments("api/review")
        .addQueryParameter("limit", limit.toString())
        .addQueryParameter("after", after.toString())
        .apply { severity.apiValue?.let { addQueryParameter("severity", it) } }
        .apply { camera?.let { addQueryParameter("cameras", it) } }
        .build()
    return getBody(url) { json.decodeFromString<List<ReviewItem>>(it).sortedByDescending { item -> item.startTime } }
}

/** How much motion [camera] saw in each [scaleSeconds] slice between [after] and [before] (epoch seconds). */
suspend fun FrigateApi.motionActivity(camera: String, after: Long, before: Long, scaleSeconds: Int): List<MotionBucket> {
    val url = base.newBuilder().addPathSegments("api/review/activity/motion")
        .addQueryParameter("cameras", camera)
        .addQueryParameter("after", after.toString())
        .addQueryParameter("before", before.toString())
        .addQueryParameter("scale", scaleSeconds.toString())
        .build()
    return getJson(url)
}

/** Marks [ids] reviewed, or unreviewed again with [reviewed] false. */
suspend fun FrigateApi.markReviewed(ids: List<String>, reviewed: Boolean = true) {
    if (ids.isEmpty()) return
    val body = buildJsonObject {
        put("ids", buildJsonArray { ids.forEach { add(it) } })
        put("reviewed", reviewed)
    }.toString().toRequestBody(JSON)
    call(Request.Builder().url(url("api/reviews/viewed")).post(body).build()) { }
}
