package com.jtn.frigateviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.ImageLoader
import coil3.compose.AsyncImage
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.thumbnailUrl
import kotlinx.coroutines.launch

/** One review item: thumbnail with severity and duration, what, where and when. */
@Composable
fun ReviewRow(
    item: ReviewItem,
    cameraLabel: String,
    session: Session,
    imageLoader: ImageLoader,
    showCamera: Boolean = true,
    trackReviews: Boolean = true,
    onSwipe: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    if (onSwipe == null || !trackReviews || item.reviewed) {
        ReviewRowContent(item, cameraLabel, session, imageLoader, showCamera, trackReviews, swipeAction = null, onClick)
        return
    }
    SwipeToReview(onSwipe) {
        ReviewRowContent(item, cameraLabel, session, imageLoader, showCamera, trackReviews, swipeAction = onSwipe, onClick)
    }
}

/**
 * A row that marks its item reviewed when swiped past [SWIPE_THRESHOLD] of its
 * width either way, with a tick once far enough, then springs back.
 */
@Composable
private fun SwipeToReview(onSwipe: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState(positionalThreshold = { it * SWIPE_THRESHOLD })
    val haptics = LocalHapticFeedback.current
    val armed = state.targetValue != SwipeToDismissBoxValue.Settled
    LaunchedEffect(armed) {
        if (armed) haptics.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
    }
    val scope = rememberCoroutineScope()
    SwipeToDismissBox(
        state = state,
        onDismiss = {
            onSwipe()
            scope.launch { state.reset() }
        },
        backgroundContent = {
            val fromStart = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            Row(
                Modifier
                    .fillMaxSize()
                    .padding(horizontal = 8.dp, vertical = 2.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(if (armed) MaterialTheme.colorScheme.primaryContainer else Palette.Surface)
                    .padding(horizontal = 24.dp),
                horizontalArrangement = if (fromStart) Arrangement.Start else Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val tint = if (armed) MaterialTheme.colorScheme.onPrimaryContainer else Palette.TextSecondary
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Outlined.DoneAll, contentDescription = null, tint = tint)
                    Text(stringResource(R.string.rev_reviewed), style = MaterialTheme.typography.labelSmall, color = tint)
                }
            }
        },
    ) { content() }
}

@Composable
private fun ReviewRowContent(
    item: ReviewItem,
    cameraLabel: String,
    session: Session,
    imageLoader: ImageLoader,
    showCamera: Boolean,
    trackReviews: Boolean,
    swipeAction: (() -> Unit)?,
    onClick: () -> Unit,
) {
    // Without review tracking every item looks the same, as if none were reviewed.
    val reviewed = trackReviews && item.reviewed
    val where = whereLine(item, cameraLabel, showCamera).resolve()
    val res = LocalResources.current
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(MaterialTheme.colorScheme.background)
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = buildString {
                    val severity = res.getString(if (item.isAlert) R.string.rev_row_alert else R.string.rev_row_detection)
                    append(res.getString(R.string.rev_row_title, item.title, severity))
                    // The severity is already said; the line only names it when nothing else is known.
                    if (where.isNotEmpty() && !where.equals(severity, ignoreCase = true)) {
                        append(res.getString(R.string.list_part, where))
                    }
                    append(res.getString(R.string.list_part, formatTime(item.startTime)))
                    val length = if (item.isOngoing) {
                        uiText(R.string.event_in_progress)
                    } else {
                        uiText(R.string.event_length, formatDuration(item.startTime, item.endTime))
                    }
                    append(res.getString(R.string.list_part, length.resolve(res)))
                    if (trackReviews) {
                        val state = res.getString(if (item.reviewed) R.string.rev_row_reviewed else R.string.rev_row_not_reviewed)
                        append(res.getString(R.string.list_part, state))
                    }
                }
                onClick {
                    onClick()
                    true
                }
                // The swipe, for those who cannot swipe.
                if (swipeAction != null) {
                    customActions = listOf(
                        CustomAccessibilityAction(res.getString(R.string.rev_mark_reviewed)) {
                            swipeAction()
                            true
                        },
                    )
                }
            }
            // Reviewed items fade back so the ones still to look at stand out.
            .alpha(if (reviewed) REVIEWED_ALPHA else 1f)
            .padding(8.dp)
            .height(68.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.fillMaxHeight().aspectRatio(16f / 9f)) {
            AsyncImage(
                model = session.api.thumbnailUrl(item),
                imageLoader = imageLoader,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).background(Palette.Surface),
            )
            SeverityDot(
                item.isAlert,
                Modifier.align(Alignment.TopStart).padding(6.dp).border(1.5.dp, Color(0x99000000), CircleShape),
            )
            OverlayTag(
                formatDuration(item.startTime, item.endTime).resolve(),
                Modifier.align(Alignment.BottomEnd).padding(4.dp),
                color = if (item.isOngoing) Palette.Live else Color.White,
            )
        }
        Column(Modifier.weight(1f).padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.title,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    shortTime(item.startTime, LocalNow.current).resolve(),
                    style = MaterialTheme.typography.bodySmall.merge(Tabular),
                    color = Palette.TextSecondary,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
            if (where.isNotEmpty()) {
                Text(
                    where,
                    style = MaterialTheme.typography.bodyMedium,
                    color = Palette.TextSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * The row's second line: the camera, when the list mixes cameras, and the zones. The time
 * is already on the first line, so without either it names the severity, and when the title
 * already does that it is left out.
 */
internal fun whereLine(item: ReviewItem, cameraLabel: String, showCamera: Boolean): UiText {
    val parts = buildList {
        if (showCamera) add(cameraLabel)
        addAll(item.data.zones.map { it.replace('_', ' ') })
    }
    if (parts.isNotEmpty()) return UiText.Plain(parts.joinToString(" · "))
    // The title is the server's severity word when nothing was labeled, so it is compared with that.
    val severity = if (item.isAlert) "alert" else "detection"
    if (item.title.equals(severity, ignoreCase = true)) return UiText.Plain("")
    return uiText(if (item.isAlert) R.string.rev_alert else R.string.rev_detection)
}

private const val REVIEWED_ALPHA = 0.55f
private const val SWIPE_THRESHOLD = 0.58f
