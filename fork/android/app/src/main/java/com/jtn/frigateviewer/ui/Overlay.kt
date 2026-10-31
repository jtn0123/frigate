package com.jtn.frigateviewer.ui

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * Screens pushed on top of the tabs. They hold names and IDs rather than the
 * objects themselves, so a screen always shows the latest data for what it is
 * about, and the stack can be saved when Android stops the app.
 */
@Serializable
sealed interface Overlay {
    @Serializable
    @SerialName("camera")
    data class CameraDetail(val camera: String) : Overlay

    @Serializable
    @SerialName("event")
    data class Event(val reviewId: String) : Overlay

    @Serializable
    @SerialName("recording")
    data class Recording(val camera: String, val minutes: Int, val end: Long) : Overlay

    /** A camera's last 24 hours, playing from [start] (epoch seconds). */
    @Serializable
    @SerialName("timeline")
    data class Timeline(val camera: String, val start: Long) : Overlay

    /** Several cameras live at once; empty means the first four. */
    @Serializable
    @SerialName("live_grid")
    data class LiveGrid(val cameras: List<String> = emptyList()) : Overlay

    @Serializable
    @SerialName("health")
    data object Health : Overlay

    /** What the WireGuard tunnel did, to share when it does not work. */
    @Serializable
    @SerialName("tunnel_log")
    data object TunnelLog : Overlay

    /** Review items from any day, not just the last 24 hours. */
    @Serializable
    @SerialName("search")
    data object Search : Overlay
}

fun encodeOverlays(overlays: List<Overlay>): String = Json.encodeToString(overlays)

/** The saved stack, or an empty one when there is none or it cannot be read (an older app version). */
fun decodeOverlays(saved: String?): List<Overlay> {
    if (saved == null) return emptyList()
    return try {
        Json.decodeFromString(saved)
    } catch (_: SerializationException) {
        emptyList()
    } catch (_: IllegalArgumentException) {
        emptyList()
    }
}
