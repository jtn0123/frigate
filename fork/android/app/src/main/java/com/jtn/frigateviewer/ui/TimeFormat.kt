package com.jtn.frigateviewer.ui

import android.text.format.DateFormat
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
import java.time.format.DecimalStyle
import java.time.format.FormatStyle
import java.util.Locale

/**
 * Whether times read 13:05 rather than 1:05 PM: the phone's 12/24-hour setting,
 * which [App] keeps current, and until it has the language's custom.
 */
internal var use24HourClock by mutableStateOf(localeUses24Hours())

private fun localeUses24Hours(): Boolean =
    DateTimeFormatterBuilder.getLocalizedDateTimePattern(null, FormatStyle.SHORT, IsoChronology.INSTANCE, Locale.getDefault())
        .contains('H')

/**
 * The phone's own date and time patterns for [locale] on a 12- or 24-hour clock, each the
 * language's best pattern for a skeleton of fields: "Tuesday, Oct 28" in English reads
 * "Dienstag, 28. Okt." in German and "10月28日火曜日" in Japanese.
 */
internal class TimePatterns(val locale: Locale, val hours24: Boolean) {
    /** "9:35:12 PM" or "21:35:12". */
    val clock = pattern(if (hours24) "Hmmss" else "hmmss", if (hours24) "H:mm:ss" else "h:mm:ss a")

    /** "9:35 PM" or "21:35". */
    val time = pattern(if (hours24) "Hmm" else "hmm", if (hours24) "H:mm" else "h:mm a")

    /** A timeline tick on the hour: "9 PM", or [time] on a 24-hour clock. */
    val hour = if (hours24) time else pattern("h", "h a")

    /** A tick between hours, short without the half of the day: "9:15". */
    val minutes = if (hours24) time else pattern("hmm", "h:mm") { withoutDayPeriod(it) }

    /** "Tuesday, Oct 28". */
    val day = pattern("EEEEMMMd", "EEEE, MMM d")

    /** "Tuesday, Oct 28, 2025". */
    val dayYear = pattern("EEEEMMMdy", "EEEE, MMM d, yyyy")

    private fun pattern(skeleton: String, fallback: String, adjust: (String) -> String = { it }): DateTimeFormatter {
        val best = adjust(forJavaTime(DateFormat.getBestDateTimePattern(locale, skeleton)))
        val formatter = try {
            DateTimeFormatter.ofPattern(best, locale)
        } catch (_: IllegalArgumentException) {
            // A field java.time cannot write, as a calendar other than the Gregorian one may ask for.
            DateTimeFormatter.ofPattern(fallback, locale)
        }
        // The language's own digits, as Arabic writes them.
        return formatter.withDecimalStyle(DecimalStyle.of(locale))
    }

    companion object {
        /**
         * [pattern] with the flexible day periods some languages use ("in the evening", the
         * letters b and B) as plain AM and PM, which java.time before Android 14 cannot write.
         */
        fun forJavaTime(pattern: String): String = mapUnquoted(pattern) { if (it == 'b' || it == 'B') "a" else it.toString() }

        /** [pattern] without its AM or PM, and without the space that set it apart: "h:mm a" is "h:mm". */
        fun withoutDayPeriod(pattern: String): String = mapUnquoted(pattern) { if (it == 'a') "" else it.toString() }.trim()

        /** [pattern] with each letter outside its 'quoted' text replaced by [map]. */
        private fun mapUnquoted(pattern: String, map: (Char) -> String): String = buildString {
            var quoted = false
            pattern.forEach { c ->
                if (c == '\'') quoted = !quoted
                append(if (quoted || c == '\'') c.toString() else map(c))
            }
        }
    }
}

@Volatile private var current: TimePatterns? = null

/**
 * The patterns for the phone's language and clock now. They are made again when either
 * changes, as when the language is switched while the app stays in memory.
 */
internal fun timePatterns(): TimePatterns {
    val locale = Locale.getDefault()
    val hours24 = use24HourClock
    return current?.takeIf { it.locale == locale && it.hours24 == hours24 } ?: TimePatterns(locale, hours24).also { current = it }
}

private fun zoned(epochSeconds: Double) =
    Instant.ofEpochMilli((epochSeconds * 1000).toLong()).atZone(ZoneId.systemDefault())

/** "9:35 PM", or "21:35" on a 24-hour clock. */
fun formatTime(epochSeconds: Double): String = zoned(epochSeconds).format(timePatterns().time)

/** "9:35:12 PM", or "21:35:12" on a 24-hour clock. */
fun formatClock(epochSeconds: Double): String = zoned(epochSeconds).format(timePatterns().clock)

/** A timeline tick's label, kept short: "9 PM" on the hour and "9:15" between, or "21:00" and "21:15". */
fun formatTick(epochSeconds: Long): String {
    val time = zoned(epochSeconds.toDouble())
    val patterns = timePatterns()
    return time.format(if (time.minute == 0) patterns.hour else patterns.minutes)
}

/** The day [epochSeconds] falls on here. */
fun localDate(epochSeconds: Double): LocalDate = zoned(epochSeconds).toLocalDate()

/** [dayLabel] of the day [epochSeconds] falls on here. */
fun dayLabel(epochSeconds: Double, today: LocalDate = LocalDate.now()): UiText = dayLabel(localDate(epochSeconds), today)

/** "Today", "Yesterday", "Tuesday, Oct 28", or "Tuesday, Oct 28, 2025" for a day in another year than [today]. */
fun dayLabel(date: LocalDate, today: LocalDate = LocalDate.now()): UiText = when (date) {
    today -> uiText(R.string.day_today)
    today.minusDays(1) -> uiText(R.string.day_yesterday)
    else -> UiText.Plain(date.format(timePatterns().let { if (date.year == today.year) it.day else it.dayYear }))
}

/** "0:42" or "12:05"; "LIVE" while still in progress. */
fun formatDuration(start: Double, end: Double?): UiText {
    if (end == null) return uiText(R.string.duration_live)
    // Round up so a sub-second item reads 0:01 rather than an empty 0:00.
    val seconds = kotlin.math.ceil(end - start).toLong().coerceAtLeast(1)
    return UiText.Plain("%d:%02d".format(seconds / 60, seconds % 60))
}
