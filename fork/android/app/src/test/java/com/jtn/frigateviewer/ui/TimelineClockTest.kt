package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.RecordingSpan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Telling a recording playlist's position in wall time, through the gaps the playlist leaves out. */
class TimelineClockTest {
    private fun span(start: Double, end: Double, durationMs: Long = ((end - start) * 1000).toLong()) =
        RecordingSpan(start, end, durationMs)

    private fun assertWall(expected: Double, actual: Double, message: String = "") = assertEquals(message, expected, actual, 0.001)

    @Test
    fun withoutGapsPlaylistTimeIsWallTime() {
        val clock = TimelineClock(1000, 1030, listOf(span(1000.0, 1010.0), span(1010.0, 1020.0), span(1020.0, 1030.0)))

        assertFalse(clock.isLinear)
        assertEquals(30_000, clock.totalMs)
        assertWall(1000.0, clock.wallAt(0))
        assertWall(1015.5, clock.wallAt(15_500))
        assertEquals(15_500L, clock.positionAt(1015.5))
        assertWall(1022.0, clock.snap(1022.0)!!)
    }

    @Test
    fun aGapInTheMiddleTakesNoPlaylistTime() {
        // Recorded 1000 to 1010 and 1100 to 1110: the playlist is 20 seconds long.
        val clock = TimelineClock(1000, 1200, listOf(span(1000.0, 1010.0), span(1100.0, 1110.0)))

        assertEquals(20_000, clock.totalMs)
        assertWall(1009.0, clock.wallAt(9_000))
        assertWall(1100.0, clock.wallAt(10_000), "Playing on past the gap jumps the clock to the next recording")
        assertWall(1105.0, clock.wallAt(15_000))
        assertEquals(15_000L, clock.positionAt(1105.0))
    }

    @Test
    fun spansAreReadInTimeOrder() {
        val clock = TimelineClock(1000, 1200, listOf(span(1100.0, 1110.0), span(1000.0, 1010.0)))

        assertWall(1105.0, clock.wallAt(15_000))
    }

    @Test
    fun aSeekIntoAGapPlaysFromTheNextRecording() {
        val clock = TimelineClock(1000, 1200, listOf(span(1000.0, 1010.0), span(1100.0, 1110.0)))

        assertEquals(10_000L, clock.positionAt(1050.0))
        assertWall(1100.0, clock.snap(1050.0)!!)
        assertWall(1100.0, clock.wallAt(clock.positionAt(1050.0)!!), "Snapping lands where the position does")
    }

    @Test
    fun aRangeStartingInAGapStartsAtTheFirstRecording() {
        val clock = TimelineClock(1000, 1200, listOf(span(1060.0, 1070.0)))

        assertWall(1060.0, clock.wallAt(0))
        assertWall(1060.0, clock.snap(1000.0)!!)
        assertEquals(0L, clock.positionAt(1000.0))
    }

    @Test
    fun aFirstRecordingStartingBeforeTheRangeIsTrimmedToIt() {
        // A raw recording from 990 to 1010 in a playlist from 1000: the server starts it 10 seconds in.
        val clock = TimelineClock(1000, 1200, listOf(span(990.0, 1010.0), span(1100.0, 1110.0)))

        assertEquals(20_000, clock.totalMs)
        assertWall(1000.0, clock.wallAt(0))
        assertWall(1005.0, clock.wallAt(5_000))
        assertWall(1100.0, clock.wallAt(10_000))
        assertWall(1000.0, clock.snap(1000.0)!!)
    }

    @Test
    fun aLastRecordingEndingAfterTheRangeIsTrimmedToIt() {
        val clock = TimelineClock(1000, 1005, listOf(span(1000.0, 1010.0)))

        assertEquals(5_000, clock.totalMs)
        assertWall(1005.0, clock.wallAt(9_000))
    }

    @Test
    fun keyframeLeadInPlaysAsTheSpansStart() {
        // The server snapped the clip back 1.5 seconds to a keyframe: 11.5 seconds of media for 10 seconds of time.
        val clock = TimelineClock(1000, 1200, listOf(span(1000.0, 1010.0, 11_500), span(1100.0, 1110.0)))

        assertWall(1000.0, clock.wallAt(0))
        assertWall(1000.0, clock.wallAt(1_500))
        assertWall(1004.0, clock.wallAt(5_500))
        assertWall(1100.0, clock.wallAt(11_500))
        assertEquals(5_500L, clock.positionAt(1004.0))
        assertEquals(11_500L, clock.positionAt(1050.0))
    }

    @Test
    fun aSegmentCutShortRunsOutBeforeItsEnd() {
        // Ten seconds of time but 8 seconds of media: the next clip starts 8 seconds in.
        val clock = TimelineClock(1000, 1200, listOf(span(1000.0, 1010.0, 8_000), span(1010.0, 1020.0)))

        assertWall(1007.0, clock.wallAt(7_000))
        assertWall(1010.0, clock.wallAt(8_000))
        assertWall(1010.0, clock.snap(1009.0)!!, "No media is left for the moment, so the next clip plays")
        assertEquals(8_000L, clock.positionAt(1009.0))
    }

    @Test
    fun clipsTheServerLeavesOutTakeNoTime() {
        // A zero duration is a clip skipped, as one that starts after its audio ended.
        val skipped = TimelineClock(1000, 1200, listOf(span(1000.0, 1010.0), span(1010.0, 1020.0, 0), span(1020.0, 1030.0)))
        assertEquals(20_000, skipped.totalMs)
        assertWall(1020.0, skipped.wallAt(10_000))
        assertWall(1020.0, skipped.snap(1015.0)!!)

        // Trimmed to under a tenth of a second, it is too short for a frame.
        val tooShort = TimelineClock(1000, 1200, listOf(span(990.0, 1000.05), span(1100.0, 1110.0)))
        assertEquals(10_000, tooShort.totalMs)
        assertWall(1100.0, tooShort.wallAt(0))
    }

    @Test
    fun aPositionBeyondTheEndIsTheLastRecordingsEnd() {
        val clock = TimelineClock(1000, 1200, listOf(span(1000.0, 1010.0), span(1100.0, 1110.0)))

        assertWall(1110.0, clock.wallAt(20_000))
        assertWall(1110.0, clock.wallAt(90_000))
        assertWall(1000.0, clock.wallAt(-1), "Before the start is the start")
    }

    @Test
    fun timesWithNothingToPlayHaveNoPosition() {
        val clock = TimelineClock(1000, 1200, listOf(span(1000.0, 1010.0), span(1100.0, 1110.0)))

        assertNull("After the last recording", clock.positionAt(1150.0))
        assertNull(clock.snap(1150.0))
        assertNull("Before the range", clock.positionAt(999.0))
        assertNull(clock.snap(999.0))
        assertNull("After the range", clock.snap(1201.0))
    }

    @Test
    fun withNoSpansTimeIsLinear() {
        val clock = TimelineClock(1000, 1200, emptyList())

        assertTrue(clock.isLinear)
        assertEquals(0, clock.totalMs)
        assertWall(1015.0, clock.wallAt(15_000))
        assertWall(1200.0, clock.wallAt(500_000), "Never past the range's end")
        assertWall(1000.0, clock.wallAt(-5))
        assertEquals(15_000L, clock.positionAt(1015.0))
        assertWall(1015.0, clock.snap(1015.0)!!)
        assertNull(clock.snap(1300.0))
    }

    @Test
    fun spansAllTrimmedAwayAreLinearToo() {
        assertTrue(TimelineClock(1000, 1200, listOf(span(900.0, 950.0))).isLinear)
    }

    @Test
    fun aDayOfSpansIsWalkedBySearchNotOneByOne() {
        // 8,640 ten-second recordings, every other one missing.
        val spans = (0 until 8_640).map { span(it * 20.0, it * 20.0 + 10) }
        val clock = TimelineClock(0, 172_800, spans)

        assertWall(43_205.0, clock.wallAt(21_605_000))
        assertEquals(21_605_000L, clock.positionAt(43_205.0))
        assertWall(43_220.0, clock.snap(43_212.0)!!)
    }

    @Test
    fun theScreensClockIsLinearUntilTheRightPlaylistIsKnown() {
        val known = TimelineClock(1000, 1200, listOf(span(1100.0, 1110.0)))

        assertWall(1100.0, clockFor(known, 1000, 1200).wallAt(0))
        assertWall(1500.0, clockFor(known, 1500, 1800).wallAt(0), "A clock for another start is not used")
        assertWall(1000.0, clockFor(null, 1000, 1200).wallAt(0))
    }
}
