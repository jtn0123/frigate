package com.jtn.frigateviewer.data

import java.net.HttpURLConnection.HTTP_NOT_FOUND
import kotlin.math.roundToLong
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * One clip of a recording playlist: the wall-clock span it serves, in epoch
 * seconds, and how many milliseconds of media the playlist holds for it. The
 * media can be longer than the span (a clip snapped back to a keyframe starts
 * a little early), shorter (a segment cut short), or none at all (a clip the
 * server leaves out).
 */
data class RecordingSpan(val startTime: Double, val endTime: Double, val durationMs: Long)

/**
 * The clips of `vod/<camera>/start/<after>/end/<before>`, in the order its
 * playlist plays them end to end, so a player's position can be told in wall time.
 *
 * Frigate's coverage timeline (`recordings/coverage?timelines=true`, the
 * default `auto` variant) is built by the same code as the playlist, so it is
 * exact. A server without it gets the raw recordings instead, which the
 * timeline trims to the range as the playlist does.
 */
suspend fun FrigateApi.recordingSpans(camera: String, after: Long, before: Long): List<RecordingSpan> {
    val coverageUrl = base.newBuilder().addPathSegments("api/$camera/recordings/coverage")
        .addQueryParameter("after", after.toString())
        .addQueryParameter("before", before.toString())
        .addQueryParameter("timelines", "true")
        .build()
    val coverage = try {
        getJson<Coverage>(coverageUrl)
    } catch (e: HttpException) {
        if (e.code != HTTP_NOT_FOUND) throw e
        null
    }
    coverage?.timelines?.let { timelines ->
        return timelines.auto.map { RecordingSpan(it.startTime, it.endTime, it.duration.roundToLong()) }
    }
    val recordingsUrl = base.newBuilder().addPathSegments("api/$camera/recordings")
        .addQueryParameter("after", after.toString())
        .addQueryParameter("before", before.toString())
        .build()
    return getJson<List<RecordingRow>>(recordingsUrl).map {
        RecordingSpan(it.startTime, it.endTime, (it.duration * MS_PER_SECOND).roundToLong())
    }
}

private const val MS_PER_SECOND = 1000.0

@Serializable
private class Coverage(val timelines: Timelines? = null)

@Serializable
private class Timelines(val auto: List<TimelineSpan> = emptyList())

/** A coverage timeline's span; its [duration] is in milliseconds. */
@Serializable
private class TimelineSpan(
    @SerialName("start_time") val startTime: Double,
    @SerialName("end_time") val endTime: Double,
    val duration: Double,
)

/** A row of `/api/<camera>/recordings`; its [duration] is in seconds. */
@Serializable
private class RecordingRow(
    @SerialName("start_time") val startTime: Double,
    @SerialName("end_time") val endTime: Double,
    val duration: Double,
)
