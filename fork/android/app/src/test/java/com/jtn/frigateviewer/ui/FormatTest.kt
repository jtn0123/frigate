package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.ReviewData
import com.jtn.frigateviewer.data.ReviewItem
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FormatTest {
    @Test
    fun aFingerprintIsShortenedToItsEnds() {
        val pin = (0 until 32).joinToString(":") { "%02X".format(it) }

        assertEquals("00:01:02 … 1D:1E:1F", shortFingerprint(pin))
    }

    @Test
    fun aShortValueIsLeftAlone() {
        assertEquals("AA:BB", shortFingerprint("AA:BB"))
    }

    @Test
    fun recentItemsShowMinutesAndOlderOnesTheClock() {
        val now = System.currentTimeMillis() / 1000.0

        assertEquals("now", shortTime(now - 5).english())
        assertEquals("12m", shortTime(now - 12 * 60 - 5).english())
        assertEquals(formatTime(now - 2 * 3600), shortTime(now - 2 * 3600).english())
    }

    @Test
    fun daysNameTheYearOnlyWhenItIsNotThisOne() {
        val today = LocalDate.of(2026, 10, 31)

        assertEquals("Today", dayLabel(today, today).english())
        assertEquals("Yesterday", dayLabel(today.minusDays(1), today).english())
        assertEquals("Tuesday, Oct 27", dayLabel(LocalDate.of(2026, 10, 27), today).english())
        assertEquals("Monday, Oct 27, 2025", dayLabel(LocalDate.of(2025, 10, 27), today).english())
    }

    @Test
    fun theLivePillNamesTheFirstThingAndCountsTheRest() {
        assertEquals("MOTION", pillLabel("Motion"))
        assertEquals("PERSON +2", pillLabel("Person, Car, Dog"))
    }

    @Test
    fun theSecondLineNamesWhereAndNeverRepeatsTheTime() {
        val item = ReviewItem(id = "1", camera = "driveway", startTime = 1.0, endTime = 2.0, severity = "alert", thumbPath = "/t.webp")
        val person = item.copy(data = ReviewData(objects = listOf("person")))

        assertEquals(
            "Driveway · front yard",
            whereLine(person.copy(data = person.data.copy(zones = listOf("front_yard"))), "Driveway", true).english(),
        )
        assertEquals("Driveway", whereLine(person, "Driveway", showCamera = true).english())
        assertEquals("Alert", whereLine(person, "Driveway", showCamera = false).english())
        assertEquals("The title already says alert", "", whereLine(item, "Driveway", showCamera = false).english())
    }

    @Test
    fun anItemSaysWhenAndHowLongOnOneLine() {
        val start = System.currentTimeMillis() / 1000.0 - 600
        val item =
            ReviewItem(id = "1", camera = "driveway", startTime = start, endTime = start + 42, severity = "alert", thumbPath = "/t.webp")

        assertEquals("Today · ${formatClock(start)} · 0:42 long", eventWhen(item).english())
        assertEquals("Today · ${formatClock(start)} · in progress", eventWhen(item.copy(endTime = null)).english())
    }
}
