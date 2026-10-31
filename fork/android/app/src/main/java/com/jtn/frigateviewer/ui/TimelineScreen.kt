package com.jtn.frigateviewer.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SkipNext
import androidx.compose.material.icons.outlined.SkipPrevious
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.MotionBucket
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.motionActivity
import com.jtn.frigateviewer.data.vodUrl
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * A camera's last 24 hours: drag the strip to scrub, and recordings play from
 * wherever it is let go. Motion and review items are drawn along it, and the
 * playhead follows the video while it plays.
 */
@Composable
fun TimelineScreen(vm: AppViewModel, session: Session, camera: Camera, start: Long) {
    // The right edge is when the screen opened, so the strip does not creep while scrubbing.
    val end by rememberSaveable { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    val from = end - DAY_SECONDS
    val latest = end - LIVE_EDGE_SECONDS
    var playFrom by rememberSaveable { mutableLongStateOf(start.coerceIn(from, latest)) }
    var at by rememberSaveable { mutableLongStateOf(playFrom) }
    var scrubbing by remember { mutableStateOf(false) }
    val motion by produceState(emptyList<MotionBucket>(), camera.name, from) {
        (vm.fetch { it.motionActivity(camera.name, from, end, MOTION_SCALE_SECONDS) } as? Remote.Ready)?.let { value = it.value }
    }
    val reviews = vm.reviewsFor(camera.name)
    val play: (Long) -> Unit = { time ->
        scrubbing = false
        at = time.coerceIn(from, latest)
        playFrom = at
    }

    PlaybackLayout(
        vm = vm,
        url = session.api.vodUrl(camera.name, playFrom, end),
        session = session,
        aspectRatio = camera.aspectRatio,
        title = camera.label,
        onPosition = { ms -> if (!scrubbing) at = (playFrom + ms / 1000).coerceAtMost(end) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(formatClock(at.toDouble()), style = MaterialTheme.typography.headlineSmall.merge(Tabular))
            Text(dayLabel(at.toDouble()), style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
        }
        TimelineStrip(
            from = from,
            to = end,
            at = at,
            motion = motion,
            reviews = reviews,
            onScrub = {
                scrubbing = true
                at = it
            },
            onRelease = play,
        )
        DayOverview(from, end, at, reviews, onPick = play)
        val previous = previousReview(reviews, at)
        val next = nextReview(reviews, at)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilledTonalButton(onClick = {
                previous?.let { play(it.startTime.toLong() - EVENT_LEAD_SECONDS) }
            }, enabled = previous != null, modifier = Modifier.weight(1f)) {
                Icon(Icons.Outlined.SkipPrevious, contentDescription = null)
                Text("Earlier event")
            }
            FilledTonalButton(onClick = {
                next?.let { play(it.startTime.toLong() - EVENT_LEAD_SECONDS) }
            }, enabled = next != null, modifier = Modifier.weight(1f)) {
                Text("Later event")
                Icon(Icons.Outlined.SkipNext, contentDescription = null)
            }
        }
    }
}

/** The latest item that started before [at], with a moment's leeway so it does not find the one playing. */
internal fun previousReview(reviews: List<ReviewItem>, at: Long): ReviewItem? =
    reviews.filter { it.startTime < at - EVENT_LEAD_SECONDS - 1 }.maxByOrNull { it.startTime }

/** The earliest item that starts after [at], skipping one [at] was just moved in front of. */
internal fun nextReview(reviews: List<ReviewItem>, at: Long): ReviewItem? =
    reviews.filter { it.startTime > at + EVENT_LEAD_SECONDS + 1 }.minByOrNull { it.startTime }

/** A two-hour window centered on [at], dragged sideways to move through time. */
@Composable
private fun TimelineStrip(
    from: Long,
    to: Long,
    at: Long,
    motion: List<MotionBucket>,
    reviews: List<ReviewItem>,
    onScrub: (Long) -> Unit,
    onRelease: (Long) -> Unit,
) {
    val current by rememberUpdatedState(at)
    var dragged by remember { mutableStateOf<Double?>(null) }
    val measurer = rememberTextMeasurer()
    val colors = TimelineColors(
        motion = Palette.TextSecondary.copy(alpha = MOTION_ALPHA),
        tick = Palette.TextSecondary,
        alert = Palette.Alert,
        detection = Palette.Detection,
        playhead = Palette.AccentText,
        outside = Palette.Background,
    )
    val labelStyle = MaterialTheme.typography.labelSmall.copy(color = Palette.TextSecondary)
    val maxMotion = motion.maxOfOrNull { it.motion }?.takeIf { it > 0 } ?: 1.0
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(STRIP_HEIGHT)
            .clip(RoundedCornerShape(16.dp))
            .background(Palette.Surface)
            .pointerInput(from, to) {
                detectHorizontalDragGestures(
                    onDragStart = { dragged = current.toDouble() },
                    onDragEnd = { dragged?.let { onRelease(it.toLong()) } },
                    onDragCancel = { dragged?.let { onRelease(it.toLong()) } },
                ) { change, dx ->
                    change.consume()
                    val next = ((dragged ?: current.toDouble()) - dx * WINDOW_SECONDS / size.width)
                        .coerceIn(from.toDouble(), to.toDouble())
                    dragged = next
                    onScrub(next.toLong())
                }
            }
            .semantics {
                contentDescription = "Timeline"
                stateDescription = "At ${formatClock(at.toDouble())}, ${dayLabel(at.toDouble())}"
                customActions = listOf(
                    CustomAccessibilityAction("Back 5 minutes") {
                        onRelease(at - FIVE_MINUTES)
                        true
                    },
                    CustomAccessibilityAction("Forward 5 minutes") {
                        onRelease(at + FIVE_MINUTES)
                        true
                    },
                    CustomAccessibilityAction("Back 1 hour") {
                        onRelease(at - HOUR_SECONDS)
                        true
                    },
                    CustomAccessibilityAction("Forward 1 hour") {
                        onRelease(at + HOUR_SECONDS)
                        true
                    },
                )
            },
    ) {
        val windowStart = at - WINDOW_SECONDS / 2.0
        val perSecond = (size.width / WINDOW_SECONDS).toFloat()
        fun x(time: Double) = ((time - windowStart) * perSecond).toFloat()

        // Before the 24 hours and after now there is nothing to play.
        drawRect(colors.outside, Offset.Zero, Size(x(from.toDouble()).coerceIn(0f, size.width), size.height))
        val toX = x(to.toDouble()).coerceIn(0f, size.width)
        drawRect(colors.outside, Offset(toX, 0f), Size(size.width - toX, size.height))

        val motionTop = size.height * MOTION_TOP
        val barWidth = (MOTION_SCALE_SECONDS * perSecond).coerceAtLeast(1f)
        motion.forEach { bucket ->
            val left = x(bucket.startTime)
            if (left < -barWidth || left > size.width || bucket.motion <= 0) return@forEach
            val height = ((bucket.motion / maxMotion) * (size.height - motionTop)).toFloat()
            drawRect(colors.motion, Offset(left, size.height - height), Size(barWidth, height))
        }

        val laneTop = REVIEW_LANE_TOP.toPx()
        val laneHeight = REVIEW_LANE_HEIGHT.toPx()
        reviews.forEach { item ->
            val left = x(item.startTime)
            val right = x(item.endTime ?: to.toDouble()).coerceAtLeast(left + MIN_REVIEW_WIDTH.toPx())
            if (right < 0 || left > size.width) return@forEach
            drawRoundRect(
                if (item.isAlert) colors.alert else colors.detection,
                Offset(left, laneTop),
                Size(right - left, laneHeight),
                CornerRadius(laneHeight / 2),
            )
        }

        drawTicks(windowStart, perSecond, measurer, labelStyle, colors.tick)

        val center = size.width / 2
        drawLine(colors.playhead, Offset(center, 0f), Offset(center, size.height), strokeWidth = PLAYHEAD_WIDTH.toPx())
    }
}

/** A short tick and a clock label every quarter hour across the window. */
private fun DrawScope.drawTicks(
    windowStart: Double,
    perSecond: Float,
    measurer: TextMeasurer,
    style: androidx.compose.ui.text.TextStyle,
    color: Color,
) {
    val labelTop = TICK_LABEL_TOP.toPx()
    var tick = (windowStart / QUARTER_HOUR).toLong() * QUARTER_HOUR + QUARTER_HOUR
    while (tick < windowStart + WINDOW_SECONDS) {
        val tx = ((tick - windowStart) * perSecond).toFloat()
        drawLine(color.copy(alpha = TICK_ALPHA), Offset(tx, labelTop - 4.dp.toPx()), Offset(tx, size.height), strokeWidth = 1f)
        val label = measurer.measure(tickFormat.format(Instant.ofEpochSecond(tick).atZone(ZoneId.systemDefault())), style)
        if (tx + 4.dp.toPx() + label.size.width < size.width) {
            drawText(label, topLeft = Offset(tx + 4.dp.toPx(), labelTop))
        }
        tick += QUARTER_HOUR
    }
}

/** All 24 hours at once, with the strip's window outlined; a tap plays from there. */
@Composable
private fun DayOverview(from: Long, to: Long, at: Long, reviews: List<ReviewItem>, onPick: (Long) -> Unit) {
    val alert = Palette.Alert
    val detection = Palette.Detection
    val window = Palette.AccentText
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(OVERVIEW_HEIGHT)
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.Surface)
            .pointerInput(from, to) {
                detectTapGestures { offset -> onPick(from + ((offset.x / size.width) * (to - from)).toLong()) }
            }
            .semantics { contentDescription = "Last 24 hours" },
    ) {
        val span = (to - from).toFloat()
        fun x(time: Double) = ((time - from) / span * size.width).toFloat()
        reviews.forEach { item ->
            val left = x(item.startTime)
            drawLine(
                if (item.isAlert) alert else detection,
                Offset(left, size.height * OVERVIEW_MARK_TOP),
                Offset(left, size.height * (1 - OVERVIEW_MARK_TOP)),
                strokeWidth = 2.dp.toPx(),
            )
        }
        val left = x(at - WINDOW_SECONDS / 2.0).coerceAtLeast(0f)
        val right = x(at + WINDOW_SECONDS / 2.0).coerceAtMost(size.width)
        drawRoundRect(
            window,
            Offset(left, 1.dp.toPx()),
            Size(right - left, size.height - 2.dp.toPx()),
            CornerRadius(6.dp.toPx()),
            style = Stroke(1.5.dp.toPx()),
        )
    }
}

private class TimelineColors(
    val motion: Color,
    val tick: Color,
    val alert: Color,
    val detection: Color,
    val playhead: Color,
    val outside: Color,
)

private val tickFormat = DateTimeFormatter.ofPattern("h:mm")

private const val DAY_SECONDS = 86_400L
private const val HOUR_SECONDS = 3_600L
private const val FIVE_MINUTES = 300L
private const val QUARTER_HOUR = 900L
private const val WINDOW_SECONDS = 7_200.0

/** Recordings of the last moments are still being written, so playing stops short of now. */
private const val LIVE_EDGE_SECONDS = 30L

/** Playing an event starts a little before it, to see what led up to it. */
private const val EVENT_LEAD_SECONDS = 5L
private const val MOTION_SCALE_SECONDS = 60
private const val MOTION_TOP = 0.45f
private const val MOTION_ALPHA = 0.45f
private const val TICK_ALPHA = 0.3f
private const val OVERVIEW_MARK_TOP = 0.2f
private val STRIP_HEIGHT = 112.dp
private val OVERVIEW_HEIGHT = 32.dp
private val REVIEW_LANE_TOP = 10.dp
private val REVIEW_LANE_HEIGHT = 8.dp
private val MIN_REVIEW_WIDTH = 4.dp
private val TICK_LABEL_TOP = 26.dp
private val PLAYHEAD_WIDTH = 2.dp
