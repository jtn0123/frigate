package com.jtn.frigateviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.VideocamOff
import androidx.compose.material.icons.outlined.ViewAgenda
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.CameraActivity
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.Session

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CamerasScreen(vm: AppViewModel, session: Session) {
    val cameras = (vm.cameras as? Remote.Ready)?.value
    val columns = session.settings.gridColumns
    Column(Modifier.fillMaxSize()) {
        ScreenHeader(
            title = "Cameras",
            subtitle = cameras?.let { list ->
                val toReview = if (vm.trackReviews) vm.unreviewedAlerts else 0
                buildString {
                    append("${list.size} cameras")
                    if (toReview > 0) append(" · $toReview alerts to review")
                }
            },
        ) {
            if (cameras.orEmpty().size > 1) {
                IconButton(onClick = { vm.nav.push(Overlay.LiveGrid()) }) {
                    Icon(Icons.Outlined.Dashboard, contentDescription = "Watch several live")
                }
            }
            IconButton(onClick = vm::toggleGridColumns) {
                Icon(
                    if (columns == 1) Icons.Outlined.GridView else Icons.Outlined.ViewAgenda,
                    contentDescription = if (columns == 1) "Show two columns" else "Show one column",
                )
            }
        }
        TabSheet {
            RemoteContent(vm.cameras, onRetry = vm::refreshCameras, placeholder = { CameraGridSkeleton(columns) }) { list ->
                PullToRefreshBox(
                    isRefreshing = vm.refreshingReviews,
                    onRefresh = {
                        vm.refreshCameras()
                        vm.refreshReviews()
                    },
                ) {
                    if (list.isEmpty()) {
                        EmptyState(
                            Icons.Outlined.VideocamOff,
                            "No cameras",
                            detail = "Add cameras to Frigate's config, or ask an admin for access to them.",
                            action = EmptyAction("Refresh") { vm.refreshCameras() },
                        )
                    } else {
                        BoxWithConstraints {
                            // Phones get the chosen 1 or 2 columns; tablets fit as many as the width allows.
                            val cells = if (maxWidth < 600.dp) {
                                StaggeredGridCells.Fixed(columns)
                            } else {
                                StaggeredGridCells.Adaptive(if (columns == 1) 420.dp else 260.dp)
                            }
                            LazyVerticalStaggeredGrid(
                                columns = cells,
                                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 16.dp),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                verticalItemSpacing = 10.dp,
                                modifier = Modifier.fillMaxSize(),
                            ) {
                                items(list, key = { it.name }) { camera ->
                                    CameraTile(
                                        session = session,
                                        camera = camera,
                                        events = vm.reviewsFor(camera.name),
                                        now = vm.feed.activity[camera.name]?.let(::activityLabel),
                                        compact = columns > 1,
                                        trackReviews = vm.trackReviews,
                                        onClick = { vm.nav.openCamera(camera.name) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CameraTile(
    session: Session,
    camera: Camera,
    events: List<ReviewItem>,
    /** What the camera sees right now, such as "Person" or "Motion", from the live feed. */
    now: String?,
    compact: Boolean,
    trackReviews: Boolean,
    onClick: () -> Unit,
) {
    val toReview = if (trackReviews) events.count { it.isAlert && !it.reviewed } else 0
    val latest = events.maxByOrNull { it.startTime }
    val activity = latest?.let { "${it.title} · ${timeAgo(it.startTime)}" } ?: "No activity in 24h"
    // Ask Frigate for frames the size the tile shows, not one size for every layout.
    var tileHeight by remember { mutableIntStateOf(0) }
    Box(
        Modifier
            .fillMaxWidth()
            // Two columns crop every camera to the same shape so the grid lines up;
            // one column shows each camera whole.
            .aspectRatio(if (compact) 16f / 9f else camera.aspectRatio)
            .clip(RoundedCornerShape(14.dp))
            .background(Color.Black)
            .onSizeChanged { tileHeight = it.height }
            .clickable(onClick = onClick)
            .clearAndSetSemantics {
                role = Role.Button
                contentDescription = buildString {
                    append(camera.label)
                    if (!camera.enabled) append(", disabled")
                    if (now != null) append(", $now now")
                    if (toReview > 0) append(", $toReview alerts to review")
                    append(", $activity")
                }
                onClick {
                    onClick()
                    true
                }
            },
    ) {
        if (camera.enabled) {
            LiveFrame(
                api = session.api,
                camera = camera.name,
                intervalMs = 5_000,
                height = snapshotHeight(tileHeight),
                active = tileHeight > 0,
                modifier = Modifier.fillMaxSize(),
                contentScale = if (compact) ContentScale.Crop else ContentScale.Fit,
            )
        } else {
            Text("Disabled", color = Palette.TextSecondary, modifier = Modifier.align(Alignment.Center))
        }
        if (now != null) {
            LivePill(now.uppercase(), live = true, Modifier.align(Alignment.TopStart).padding(if (compact) 6.dp else 8.dp))
        }
        if (toReview > 0) {
            CountBadge(toReview, Palette.Alert, Modifier.align(Alignment.TopEnd).padding(if (compact) 6.dp else 8.dp))
        }
        Column(
            Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .background(BottomScrim)
                .padding(horizontal = if (compact) 10.dp else 12.dp, vertical = if (compact) 8.dp else 10.dp)
                .padding(top = 16.dp),
        ) {
            Text(
                camera.label,
                style = if (compact) MaterialTheme.typography.titleSmall else MaterialTheme.typography.titleMedium,
                color = Color.White,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                activity,
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xCCFFFFFF),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** "Person, Car" while objects are tracked, "Motion" for motion alone, or null when still. */
internal fun activityLabel(activity: CameraActivity): String? = when {
    activity.objects.isNotEmpty() -> activity.objects.joinToString { it.replace('_', ' ').replaceFirstChar(Char::uppercase) }
    activity.motion -> "Motion"
    else -> null
}

/**
 * The snapshot height to request for a tile [pixels] tall: the next of a few
 * fixed sizes, so resizing does not change the request for every pixel and
 * Frigate's cache stays useful.
 */
internal fun snapshotHeight(pixels: Int): Int = SNAPSHOT_HEIGHTS.firstOrNull { it >= pixels } ?: SNAPSHOT_HEIGHTS.last()

private val SNAPSHOT_HEIGHTS = listOf(180, 270, 360, 540, 720)
