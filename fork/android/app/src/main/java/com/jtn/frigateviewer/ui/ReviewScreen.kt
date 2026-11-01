package com.jtn.frigateviewer.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import coil3.ImageLoader
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.Severity
import java.time.Instant
import java.time.ZoneId

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ReviewScreen(vm: AppViewModel, session: Session, imageLoader: ImageLoader) {
    val all = (vm.reviews as? Remote.Ready)?.value.orEmpty()
    val items = vm.filteredReviews
    val unreviewed = if (vm.trackReviews) items.count { !it.reviewed } else 0
    var confirmMarkAll by remember { mutableStateOf(false) }
    // Folded days are kept as dates (epoch days), not labels: after midnight "Today" is another day.
    var collapsedDays by rememberSaveable { mutableStateOf(emptyList<Long>()) }
    val today = Instant.ofEpochMilli(LocalNow.current).atZone(ZoneId.systemDefault()).toLocalDate()

    Column(Modifier.fillMaxSize()) {
        ScreenHeader(
            title = stringResource(R.string.rev_tab_review),
            subtitle = buildString {
                append(
                    when {
                        !vm.trackReviews -> stringResource(R.string.rev_last_24_hours)
                        unreviewed > 0 -> stringResource(R.string.rev_subtitle_to_review, unreviewed)
                        else -> stringResource(R.string.rev_subtitle_caught_up)
                    },
                )
                // Counts and Mark all cover only what was fetched.
                if (vm.reviewsCapped) append(stringResource(R.string.rev_subtitle_capped, "%,d".format(FrigateApi.REVIEW_LIMIT)))
            },
        ) {
            IconButton(onClick = { vm.nav.push(Overlay.Search) }) {
                Icon(Icons.Outlined.Search, contentDescription = stringResource(R.string.rev_search_older))
            }
            if (vm.trackReviews) {
                IconButton(onClick = { confirmMarkAll = true }, enabled = unreviewed > 0) {
                    Icon(Icons.Outlined.DoneAll, contentDescription = stringResource(R.string.rev_mark_all))
                }
            }
        }

        val haptics = LocalHapticFeedback.current
        val inScope = all.filter { vm.cameraFilter == null || it.camera == vm.cameraFilter }
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            val options = listOf(
                Severity.ALERT to stringResource(R.string.rev_filter_alerts, inScope.count { it.isAlert }),
                Severity.DETECTION to stringResource(R.string.rev_filter_detections, inScope.count { !it.isAlert }),
                Severity.ALL to stringResource(R.string.rev_filter_all, inScope.size),
            )
            options.forEachIndexed { index, (severity, label) ->
                SegmentedButton(
                    selected = vm.severity == severity,
                    onClick = {
                        if (vm.severity != severity) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                        vm.severity = severity
                    },
                    shape = SegmentedButtonDefaults.itemShape(index, options.size),
                    colors = SegmentedButtonDefaults.colors(
                        activeContainerColor = MaterialTheme.colorScheme.primaryContainer,
                        activeContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                        inactiveContainerColor = Color.Transparent,
                    ),
                    border = SegmentedButtonDefaults.borderStroke(
                        if (vm.severity == severity) Palette.AccentText else MaterialTheme.colorScheme.outline,
                    ),
                    icon = {},
                ) { Text(label, maxLines = 1) }
            }
        }

        val cameras = (vm.cameras as? Remote.Ready)?.value.orEmpty()
        val chips = rememberLazyListState()
        // Arriving from a camera's screen selects a chip that may be off to the right.
        LaunchedEffect(vm.cameraFilter, cameras) {
            val index = cameras.indexOfFirst { it.name == vm.cameraFilter }
            if (index >= 0) chips.animateScrollToItem(index + 1)
        }
        LazyRow(
            state = chips,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                val allCameras = stringResource(R.string.rev_all_cameras)
                FilterChip(selected = vm.cameraFilter == null, onClick = {
                    if (vm.cameraFilter != null) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    vm.cameraFilter = null
                }, label = { Text(allCameras) }, colors = chipColors(), border = chipBorder(vm.cameraFilter == null))
            }
            items(cameras, key = { it.name }) { camera ->
                FilterChip(
                    selected = vm.cameraFilter == camera.name,
                    onClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                        vm.cameraFilter = if (vm.cameraFilter == camera.name) null else camera.name
                    },
                    label = { Text(camera.label) },
                    colors = chipColors(),
                    border = chipBorder(vm.cameraFilter == camera.name),
                )
            }
        }

        TabSheet(Modifier.padding(top = 4.dp)) {
            RemoteContent(vm.reviews, onRetry = vm::refreshReviews, placeholder = { ReviewListSkeleton() }) {
                PullToRefreshBox(isRefreshing = vm.refreshingReviews, onRefresh = vm::refreshReviews) {
                    if (items.isEmpty()) {
                        ReviewEmpty(vm)
                    } else {
                        val byDay = remember(items) { items.groupBy { localDate(it.startTime) } }
                        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
                            byDay.forEach { (date, dayItems) ->
                                val day = date.toEpochDay()
                                val folded = day in collapsedDays
                                stickyHeader(key = "day-$day") {
                                    DayHeader(
                                        dayLabel(date, today).resolve(),
                                        dayItems.size,
                                        collapsed = folded,
                                        onToggle = { collapsedDays = if (folded) collapsedDays - day else collapsedDays + day },
                                        modifier = Modifier.background(MaterialTheme.colorScheme.background),
                                    )
                                }
                                if (folded) return@forEach
                                items(dayItems, key = { it.id }) { item ->
                                    ReviewRow(
                                        item,
                                        vm.cameraLabel(item.camera),
                                        session,
                                        imageLoader,
                                        trackReviews = vm.trackReviews,
                                        onSwipe = { vm.swipeReviewed(item) },
                                    ) {
                                        vm.openEvent(item)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (confirmMarkAll) {
        AlertDialog(
            onDismissRequest = { confirmMarkAll = false },
            title = { Text(stringResource(R.string.rev_mark_all_title, unreviewed)) },
            text = { Text(stringResource(R.string.rev_mark_all_detail)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmMarkAll = false
                    vm.markAllReviewed()
                }) { Text(stringResource(R.string.rev_mark_reviewed)) }
            },
            dismissButton = { TextButton(onClick = { confirmMarkAll = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/** The selected filter takes the accent's tint, which stands out on the header band. */
@Composable
internal fun chipColors() = FilterChipDefaults.filterChipColors(
    selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
    selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer,
)

/**
 * The selected filter is also ringed in the accent: in themes whose accent tint sits
 * close to the header band, the fill alone barely shows which one is on.
 */
@Composable
internal fun chipBorder(selected: Boolean) = FilterChipDefaults.filterChipBorder(
    enabled = true,
    selected = selected,
    borderColor = MaterialTheme.colorScheme.outline,
    selectedBorderColor = Palette.AccentText,
    selectedBorderWidth = 1.dp,
)

/** A day's label and count, a rule to the edge, and a chevron that folds the day away. */
@Composable
private fun DayHeader(day: String, count: Int, collapsed: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val turn by animateFloatAsState(if (collapsed) 0f else 180f, label = "chevron")
    val state = stringResource(if (collapsed) R.string.rev_collapsed else R.string.rev_expanded)
    Row(
        modifier
            .fillMaxWidth()
            .toggleable(value = !collapsed, role = Role.Button, onValueChange = { onToggle() })
            .semantics(mergeDescendants = true) { stateDescription = state }
            .padding(start = 20.dp, end = 16.dp, top = 14.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            stringResource(R.string.rev_day_count, day, count),
            style = MaterialTheme.typography.labelLarge.merge(Tabular),
            color = Palette.TextSecondary,
        )
        HorizontalDivider(Modifier.weight(1f), color = Palette.Outline)
        Icon(
            Icons.Outlined.ExpandMore,
            contentDescription = null,
            tint = Palette.TextSecondary,
            modifier = Modifier.size(18.dp).rotate(turn),
        )
    }
}

/** An empty list, offering to widen the filters that emptied it. */
@Composable
private fun ReviewEmpty(vm: AppViewModel) {
    val what = when (vm.severity) {
        Severity.ALERT -> stringResource(R.string.rev_empty_alerts)
        Severity.DETECTION -> stringResource(R.string.rev_empty_detections)
        Severity.ALL -> stringResource(R.string.rev_empty_all)
    }
    val camera = vm.cameraFilter?.let(vm::cameraLabel)
    EmptyState(
        Icons.Outlined.TaskAlt,
        if (camera != null) stringResource(R.string.rev_empty_on_camera, what, camera) else what,
        detail = stringResource(R.string.rev_empty_detail),
        tint = Palette.Ok,
        action = when {
            camera != null -> EmptyAction(stringResource(R.string.rev_show_all_cameras)) { vm.cameraFilter = null }
            vm.severity != Severity.ALL -> EmptyAction(stringResource(R.string.rev_show_everything)) { vm.severity = Severity.ALL }
            else -> null
        },
    )
}
