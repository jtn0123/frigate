package com.jtn.frigateviewer.ui

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Dates, times and figures are written the way the phone's language writes them, on its 12- or 24-hour clock. */
@RunWith(RobolectricTestRunner::class)
class LocaleFormatTest {
    private val initialLocale = Locale.getDefault()
    private val initialClock = use24HourClock

    @After
    fun tearDown() {
        Locale.setDefault(initialLocale)
        use24HourClock = initialClock
    }

    private val afternoon = LocalTime.of(13, 5)
    private val tuesday = LocalDate.of(2026, 10, 27)

    @Test
    fun englishTimesFollowTheClockSetting() {
        val twelve = TimePatterns(Locale.US, hours24 = false)
        assertEquals("1:05 PM", afternoon.format(twelve.time))
        assertEquals("1:05:00 PM", afternoon.format(twelve.clock))
        assertEquals("1 PM", LocalTime.of(13, 0).format(twelve.hour))
        assertEquals("1:15", LocalTime.of(13, 15).format(twelve.minutes))

        val twentyFour = TimePatterns(Locale.US, hours24 = true)
        assertEquals("13:05", afternoon.format(twentyFour.time))
        assertEquals("13:05:00", afternoon.format(twentyFour.clock))
        assertEquals("13:00", LocalTime.of(13, 0).format(twentyFour.hour))
    }

    @Test
    fun daysAreWrittenInTheLanguagesOwnOrder() {
        val german = TimePatterns(Locale.GERMANY, hours24 = true)
        assertEquals("Dienstag, 27. Okt.", tuesday.format(german.day))
        assertEquals("Dienstag, 27. Okt. 2026", tuesday.format(german.dayYear))
        assertEquals("13:05", afternoon.format(german.time))

        val japanese = TimePatterns(Locale.JAPAN, hours24 = false)
        assertEquals("10月27日火曜日", tuesday.format(japanese.day))
        // The half of the day comes first in Japanese, and a tick between hours leaves it out.
        assertEquals("午後1:05", afternoon.format(japanese.time))
        assertEquals("1:15", LocalTime.of(13, 15).format(japanese.minutes))
    }

    @Test
    fun arabicTimesUseArabicDigits() {
        assertEquals("١٣:٠٥", afternoon.format(TimePatterns(Locale.forLanguageTag("ar-EG"), hours24 = true).time))
    }

    @Test
    fun switchingTheLanguageRewritesTheDays() {
        val today = LocalDate.of(2026, 10, 31)
        Locale.setDefault(Locale.US)
        assertEquals("Tuesday, Oct 27", dayLabel(tuesday, today).english())

        Locale.setDefault(Locale.GERMANY)
        assertEquals("Dienstag, 27. Okt.", dayLabel(tuesday, today).english())
        assertEquals("Montag, 27. Okt. 2025", dayLabel(LocalDate.of(2025, 10, 27), today).english())
    }

    @Test
    fun switchingTheClockSettingRewritesTheTimes() {
        Locale.setDefault(Locale.US)
        val epoch = LocalDate.now().atTime(afternoon).atZone(ZoneId.systemDefault()).toEpochSecond().toDouble()

        use24HourClock = false
        assertEquals("1:05 PM", formatTime(epoch))
        use24HourClock = true
        assertEquals("13:05", formatTime(epoch))
    }

    @Test
    fun flexibleDayPeriodsBecomeAmAndPm() {
        assertEquals("ah:mm", TimePatterns.forJavaTime("Bh:mm"))
        assertEquals("h:mm a", TimePatterns.forJavaTime("h:mm b"))
        // Quoted text is the language's words, not fields.
        assertEquals("h 'bis' a", TimePatterns.forJavaTime("h 'bis' B"))
    }

    @Test
    fun aTickBetweenHoursLeavesOutTheHalfOfTheDay() {
        assertEquals("h:mm", TimePatterns.withoutDayPeriod("h:mm a"))
        assertEquals("h:mm", TimePatterns.withoutDayPeriod("a h:mm"))
        assertEquals("K:mm", TimePatterns.withoutDayPeriod("aK:mm"))
        // German sets it apart with a narrow space.
        assertEquals("h:mm", TimePatterns.withoutDayPeriod("h:mm\u202Fa"))
        assertEquals("h 'am' mm", TimePatterns.withoutDayPeriod("h 'am' mm"))
    }

    @Test
    fun figuresUseTheLanguagesDecimalMark() {
        assertEquals("3.5", decimal(3.5, Locale.US))
        assertEquals("3,5", decimal(3.5, Locale.GERMANY))
        // Whole figures drop the zero, and large ones are grouped.
        assertEquals("8", decimal(8.0, Locale.GERMANY))
        assertEquals("1.234,6", decimal(1234.56, Locale.GERMANY))
        assertEquals("0.3", decimal(0.25, Locale.US))
    }

    @Test
    fun figuresFollowThePhonesLanguage() {
        Locale.setDefault(Locale.GERMANY)
        assertEquals("3,5 GB", size(3.5 * 1024).english())
    }
}
