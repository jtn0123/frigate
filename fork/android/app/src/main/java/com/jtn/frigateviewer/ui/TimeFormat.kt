package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.R
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.chrono.IsoChronology
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.FormatStyle
import java.util.Locale

/**
 * Whether times read 13:05 rather than 1:05 PM: the phone's 12/24-hour setting,
 * which [App] keeps current, and until it has the language's custom.
 */
internal var use24HourClock by mutableStateOf(localeUses24Hours())

private val clock12 = DateTimeFormatter.ofPattern("h:mm:ss a")
private val clock24 = DateTimeFormatter.ofPattern("H:mm:ss")
private val time12 = DateTimeFormatter.ofPattern("h:mm a")
private val time24 = DateTimeFormatter.ofPattern("H:mm")
private val hour12 = DateTimeFormatter.ofPattern("h a")
private val minutes12 = DateTimeFormatter.ofPattern("h:mm")
private val dayFormat = DateTimeFormatter.ofPattern("EEEE, MMM d")
private val dayYearFormat = DateTimeFormatter.ofPattern("EEEE, MMM d, yyyy")

private fun localeUses24Hours(): Boolean =
    DateTimeFormatterBuilder.getLocalizedDateTimePattern(null, FormatStyle.SHORT, IsoChronology.INSTANCE, Locale.getDefault())
        .contains('H')

private fun zoned(epochSeconds: Double) =
    Instant.ofEpochMilli((epochSeconds * 1000).toLong()).atZone(ZoneId.systemDefault())

/** "9:35 PM", or "21:35" on a 24-hour clock. */
fun formatTime(epochSeconds: Double): String = zoned(epochSeconds).format(if (use24HourClock) time24 else time12)

/** "9:35:12 PM", or "21:35:12" on a 24-hour clock. */
fun formatClock(epochSeconds: Double): String = zoned(epochSeconds).format(if (use24HourClock) clock24 else clock12)

/** A timeline tick's label, kept short: "9 PM" on the hour and "9:15" between, or "21:00" and "21:15". */
fun formatTick(epochSeconds: Long): String {
    val time = zoned(epochSeconds.toDouble())
    return when {
        use24HourClock -> time.format(time24)
        time.minute == 0 -> time.format(hour12)
        else -> time.format(minutes12)
    }
}

/** The day [epochSeconds] falls on here. */
fun localDate(epochSeconds: Double): LocalDate = zoned(epochSeconds).toLocalDate()

/** [dayLabel] of the day [epochSeconds] falls on here. */
fun dayLabel(epochSeconds: Double, today: LocalDate = LocalDate.now()): UiText = dayLabel(localDate(epochSeconds), today)

/** "Today", "Yesterday", "Tuesday, Oct 28", or "Tuesday, Oct 28, 2025" for a day in another year than [today]. */
fun dayLabel(date: LocalDate, today: LocalDate = LocalDate.now()): UiText = when (date) {
    today -> uiText(R.string.day_today)
    today.minusDays(1) -> uiText(R.string.day_yesterday)
    else -> UiText.Plain(date.format(if (date.year == today.year) dayFormat else dayYearFormat))
}

/** "0:42" or "12:05"; "LIVE" while still in progress. */
fun formatDuration(start: Double, end: Double?): UiText {
    if (end == null) return uiText(R.string.duration_live)
    // Round up so a sub-second item reads 0:01 rather than an empty 0:00.
    val seconds = kotlin.math.ceil(end - start).toLong().coerceAtLeast(1)
    return UiText.Plain("%d:%02d".format(seconds / 60, seconds % 60))
}
