package com.jtn.frigateviewer.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** A camera as described by Frigate's `/api/config`. */
data class Camera(
    val name: String,
    val label: String,
    val order: Int,
    val enabled: Boolean,
    /** go2rtc stream names keyed by their UI label, in config order. */
    val liveStreams: Map<String, String>,
    /** Detect resolution, used as the aspect ratio for tiles. */
    val width: Int,
    val height: Int,
    /** Set up for ONVIF, so it may pan, tilt or zoom. */
    val onvif: Boolean = false,
) {
    /** The go2rtc stream for live video, which Frigate names after the camera by default. */
    val primaryStream: String get() = liveStreams.values.firstOrNull() ?: name

    val aspectRatio: Float get() = if (width > 0 && height > 0) width.toFloat() / height else 16f / 9f
}

/** What the app needs from `/api/config`. */
data class ServerConfig(
    val cameras: List<Camera>,
    /** go2rtc stream names, or null when the config has no go2rtc section. */
    val liveStreams: Set<String>?,
    /** Semantic search is on, so tracked objects can be found by describing them. */
    val semanticSearch: Boolean = false,
)

@Serializable
data class ReviewData(
    val objects: List<String> = emptyList(),
    val zones: List<String> = emptyList(),
    val audio: List<String> = emptyList(),
    /** The tracked objects (events) the item is made of, whose snapshots can be fetched. */
    val detections: List<String> = emptyList(),
)

/** One entry from `/api/review`; times are epoch seconds. */
@Serializable
data class ReviewItem(
    val id: String,
    val camera: String,
    @SerialName("start_time") val startTime: Double,
    @SerialName("end_time") val endTime: Double? = null,
    @SerialName("has_been_reviewed") val reviewed: Boolean = false,
    val severity: String,
    @SerialName("thumb_path") val thumbPath: String,
    val data: ReviewData = ReviewData(),
) {
    val isAlert: Boolean get() = severity == "alert"

    /** Objects and audio labels, deduplicated, for display. */
    val labels: List<String> get() = (data.objects + data.audio).map { it.removeSuffix("-verified") }.distinct()

    val isOngoing: Boolean get() = endTime == null

    /** "Person, Car", or the severity when nothing was labeled. */
    val title: String
        get() = labels.joinToString { it.replace('_', ' ').replaceFirstChar(Char::uppercase) }
            .ifEmpty { severity.replaceFirstChar(Char::uppercase) }
}

enum class Severity(val apiValue: String?) {
    ALL(null),
    ALERT("alert"),
    DETECTION("detection"),
}

/** Motion in one slice of time from `/api/review/activity/motion`; [motion] only compares with other slices. */
@Serializable
data class MotionBucket(
    @SerialName("start_time") val startTime: Double,
    val motion: Double = 0.0,
)
