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
import androidx.compose.runtime.derivedStateOf
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
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.CameraActivity
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.Session

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CamerasScreen(vm: AppViewModel, session: Session) {
    val cameras = (vm.cameras as? Remote.Ready)?.value
    val columns = session.settings.gridColumns
    Column(Modifier.fillMaxSize()) {
        ScreenHeader(
            title = stringResource(R.string.cameras_title),
            subtitle = cameras?.let { list ->
                val toReview = if (vm.trackReviews) vm.unreviewedAlerts else 0
                camerasSubtitle(list.size, toReview).resolve()
            },
        ) {
            if (cameras.orEmpty().size > 1) {
                IconButton(onClick = { vm.nav.push(Overlay.LiveGrid()) }) {
                    Icon(Icons.Outlined.Dashboard, contentDescription = stringResource(R.string.cameras_watch_several))
                }
            }
            IconButton(onClick = vm::toggleGridColumns) {
                Icon(
                    if (columns == 1) Icons.Outlined.GridView else Icons.Outlined.ViewAgenda,
                    contentDescription = stringResource(if (columns == 1) R.string.cameras_two_columns else R.string.cameras_one_column),
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
                            stringResource(R.string.no_cameras),
                            detail = stringResource(R.string.cameras_none_detail),
                            action = EmptyAction(stringResource(R.string.refresh)) { vm.refreshCameras() },
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
                                        summary = vm.reviewSummary(camera.name),
                                        now = vm.feed.activity[camera.name]?.let(::activityLabel)?.resolve(),
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
    summary: CameraSummary,
    /** What the camera sees right now, such as "Person" or "Motion", from the live feed. */
    now: String?,
    compact: Boolean,
    trackReviews: Boolean,
    onClick: () -> Unit,
) {
    val toReview = if (trackReviews) summary.unreviewedAlerts else 0
    val nowMillis = LocalNow.current
    val res = LocalResources.current
    val activity = summary.latest?.let { latest ->
        stringResource(R.string.camera_tile_activity, latest.title, timeAgo(latest.startTime, nowMillis).resolve())
    }
        ?: stringResource(R.string.camera_tile_no_activity)
    // Its picture is out of date, so a screen reader says so as well as the tag on it. Derived,
    // so each new picture does not compose the tile again, only a change of what is said.
    val snapshots = LocalSnapshots.current
    val offline by remember(snapshots, camera.name, camera.enabled) {
        derivedStateOf { snapshots?.get(camera.name)?.staleMs?.takeIf { camera.enabled }?.let { offlineLabel(it).resolve(res) } }
    }
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
                    if (!camera.enabled) append(res.getString(R.string.camera_tile_disabled_part))
                    offline?.let { append(res.getString(R.string.camera_tile_offline_part, it.lowercase())) }
                    if (now != null) append(res.getString(R.string.camera_tile_now_part, now))
                    if (toReview > 0) {
                        append(res.getString(R.string.list_part, res.getQuantityString(R.plurals.alerts_to_review, toReview, toReview)))
                    }
                    append(res.getString(R.string.list_part, activity))
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
            Text(stringResource(R.string.camera_disabled), color = Palette.TextSecondary, modifier = Modifier.align(Alignment.Center))
        }
        val inset = if (compact) 6.dp else 8.dp
        if (now != null) {
            // Short of the badge, when there is one, rather than running under it.
            LivePill(
                pillLabel(now),
                live = true,
                Modifier.align(Alignment.TopStart).padding(inset).padding(end = if (toReview > 0) BADGE_ROOM else 0.dp),
            )
        }
        if (toReview > 0) {
            CountBadge(toReview, Palette.Alert, Modifier.align(Alignment.TopEnd).padding(inset))
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
internal fun activityLabel(activity: CameraActivity): UiText? = when {
    activity.objects.isNotEmpty() -> UiText.Plain(activity.objects.joinToString { it.replace('_', ' ').replaceFirstChar(Char::uppercase) })
    activity.motion -> uiText(R.string.activity_motion)
    else -> null
}

/** "3 cameras · 2 alerts to review", the Cameras header's subtitle; the alerts only while there are some. */
internal fun camerasSubtitle(cameras: Int, toReview: Int): UiText {
    val count = uiPlural(R.plurals.cameras_count, cameras)
    return if (toReview > 0) uiText(R.string.cameras_subtitle, count, uiPlural(R.plurals.alerts_to_review, toReview)) else count
}

/**
 * The live pill's label: the first thing seen and how many more, such as "PERSON +2",
 * so it stays one short line however many objects are tracked. The tile's description
 * still names them all.
 */
internal fun pillLabel(now: String): String {
    val things = now.split(", ")
    val first = things.first().uppercase()
    return if (things.size > 1) "$first +${things.size - 1}" else first
}

/**
 * The snapshot height to request for a tile [pixels] tall: the next of a few
 * fixed sizes, so resizing does not change the request for every pixel and
 * Frigate's cache stays useful.
 */
internal fun snapshotHeight(pixels: Int): Int = SNAPSHOT_HEIGHTS.firstOrNull { it >= pixels } ?: SNAPSHOT_HEIGHTS.last()

private val SNAPSHOT_HEIGHTS = listOf(180, 270, 360, 540, 720)

/** Room the alert count takes at a tile's corner, up to "99+". */
private val BADGE_ROOM = 40.dp
