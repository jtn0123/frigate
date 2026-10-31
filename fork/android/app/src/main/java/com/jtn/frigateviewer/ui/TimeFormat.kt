package com.jtn.frigateviewer.ui

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val clockFormat = DateTimeFormatter.ofPattern("h:mm:ss a")
private val timeFormat = DateTimeFormatter.ofPattern("h:mm a")
private val dayFormat = DateTimeFormatter.ofPattern("EEEE, MMM d")

private fun zoned(epochSeconds: Double) =
    Instant.ofEpochMilli((epochSeconds * 1000).toLong()).atZone(ZoneId.systemDefault())

fun formatTime(epochSeconds: Double): String = zoned(epochSeconds).format(timeFormat)

fun formatClock(epochSeconds: Double): String = zoned(epochSeconds).format(clockFormat)

/** "Today", "Yesterday", or "Tuesday, Oct 28". */
fun dayLabel(epochSeconds: Double): String {
    val date = zoned(epochSeconds).toLocalDate()
    val today = LocalDate.now()
    return when (date) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> date.format(dayFormat)
    }
}

/** "just now", "4m ago", "2h ago". */
fun timeAgo(epochSeconds: Double): String {
    val seconds = (System.currentTimeMillis() / 1000.0 - epochSeconds).toLong()
    return when {
        seconds < 60 -> "just now"
        seconds < 3600 -> "${seconds / 60}m ago"
        seconds < 86_400 -> "${seconds / 3600}h ago"
        else -> "${seconds / 86_400}d ago"
    }
}

/** "now" and "12m" within the hour, then the clock time, as list rows show it. */
fun shortTime(epochSeconds: Double): String {
    val seconds = (System.currentTimeMillis() / 1000.0 - epochSeconds).toLong()
    return when {
        seconds < 60 -> "now"
        seconds < 3600 -> "${seconds / 60}m"
        else -> formatTime(epochSeconds)
    }
}

/** "0:42" or "12:05"; "LIVE" while still in progress. */
fun formatDuration(start: Double, end: Double?): String {
    if (end == null) return "LIVE"
    // Round up so a sub-second item reads 0:01 rather than an empty 0:00.
    val seconds = kotlin.math.ceil(end - start).toLong().coerceAtLeast(1)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}
