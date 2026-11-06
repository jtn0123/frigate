package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.RecordingSpan
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * Wall-clock time for a position in a recording playlist of [from] to [to]
 * (epoch seconds), and back. Frigate's playlist strings the recordings that
 * exist end to end, so time with no recording (motion-only recording, an
 * outage) takes up no playlist time: playing on through it jumps the clock
 * ahead. It mirrors how the server builds the playlist: a clip starting before
 * [from] or ending after [to] is trimmed to it, and one left with less than a
 * playable moment, or none, is left out. Media longer than its span (a clip
 * snapped back to a keyframe) plays its lead-in at the span's start.
 *
 * With no spans known, playlist time is taken as wall time from [from], as
 * when the spans could not be fetched.
 */
internal class TimelineClock(val from: Long, val to: Long, spans: List<RecordingSpan>) {
    private val clips: List<Clip>

    /** Milliseconds of media in the whole playlist. */
    val totalMs: Long

    init {
        var offset = 0L
        clips = spans.sortedBy { it.startTime }.mapNotNull { trim(it) }.map { span ->
            Clip(span.startTime, span.endTime, offset, span.durationMs).also { offset += span.durationMs }
        }
        totalMs = offset
    }

    /** Whether no spans are known, so time is linear. */
    val isLinear: Boolean get() = clips.isEmpty()

    /** The wall time [positionMs] into the playlist; past its end, the end of the last recording. */
    fun wallAt(positionMs: Long): Double {
        val position = max(positionMs, 0L)
        return when {
            isLinear -> min(from + position / MS, to.toDouble())
            position >= totalMs -> clips.last().mediaEnd
            else -> clips[lastIndex { it.offsetMs <= position }].let { clip ->
                clip.start + (position - clip.offsetMs - clip.leadInMs).coerceAtLeast(0) / MS
            }
        }
    }

    /**
     * Where [wall] is in the playlist, in milliseconds. A time with no
     * recording is where the next recording starts, as the playlist goes
     * straight on to it; null outside [from] to [to] or after the last recording.
     */
    fun positionAt(wall: Double): Long? = when {
        wall < from || wall > to -> null
        isLinear -> ((wall - from) * MS).roundToLong()
        else -> clipFor(wall)?.let { clip ->
            clip.offsetMs + clip.leadInMs + ((wall - clip.start) * MS).roundToLong().coerceIn(0, clip.durationMs - clip.leadInMs)
        }
    }

    /**
     * Where playing from [wall] really starts: [wall] itself when it was
     * recorded, else the start of the next recording, the same moment
     * [positionAt] finds. Null where [positionAt] is.
     */
    fun snap(wall: Double): Double? {
        if (wall < from || wall > to) return null
        if (isLinear) return wall
        return clipFor(wall)?.let { max(wall, it.start) }
    }

    /** The first clip whose media ends after [wall]. */
    private fun clipFor(wall: Double): Clip? = clips.getOrNull(lastIndex { it.mediaEnd <= wall } + 1)

    /** The last index whose clip satisfies [before], which holds for a leading run of clips; -1 when none does. */
    private inline fun lastIndex(before: (Clip) -> Boolean): Int {
        var low = 0
        var high = clips.size
        while (low < high) {
            val middle = (low + high) ushr 1
            if (before(clips[middle])) low = middle + 1 else high = middle
        }
        return low - 1
    }

    /** [span] cut to the range as the server cuts it, or null when it leaves the clip out. */
    private fun trim(span: RecordingSpan): RecordingSpan? {
        var start = span.startTime
        var end = span.endTime
        var duration = span.durationMs
        if (start < from) {
            duration -= ((from - start) * MS).toLong()
            start = from.toDouble()
        }
        if (end > to) {
            duration -= ((end - to) * MS).toLong()
            end = to.toDouble()
        }
        return if (duration >= MIN_CLIP_MS && end > start) RecordingSpan(start, end, duration) else null
    }

    private class Clip(val start: Double, end: Double, val offsetMs: Long, val durationMs: Long) {
        /** Media from before [start], from snapping back to a keyframe; it plays as [start]. */
        val leadInMs = (durationMs - ((end - start) * MS).roundToLong()).coerceAtLeast(0)

        /** Where this clip's media runs out: its end, or sooner for a segment cut short. */
        val mediaEnd = min(end, start + (durationMs - leadInMs) / MS)
    }

    private companion object {
        const val MS = 1000.0

        /** The server leaves out a clip shorter than this, too short for a frame. */
        const val MIN_CLIP_MS = 100L
    }
}
