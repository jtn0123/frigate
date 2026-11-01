package com.jtn.frigateviewer.ui

import android.graphics.Rect
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.filled.PictureInPictureAlt
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.NightsStay
import androidx.compose.material.icons.outlined.Timeline
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil3.ImageLoader
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.Severity

@Composable
fun CameraDetailScreen(vm: AppViewModel, session: Session, camera: Camera, imageLoader: ImageLoader) {
    val landscape = isLandscape()
    val setFullscreen = rememberFullscreenToggle()
    var muted by rememberSaveable { mutableStateOf(true) }
    // Sub streams start faster and use far less data; main is full resolution.
    val streams = camera.liveStreams.values.toList().ifEmpty { listOf(camera.name) }
    val streamNames = camera.liveStreams.keys.toList()
    var streamIndex by rememberSaveable(camera.name) { mutableIntStateOf(0) }
    val stream = streams[streamIndex.coerceIn(streams.indices)]
    var liveState by rememberSaveable(stream) { mutableStateOf(LiveState.CONNECTING) }
    val hasLive = vm.hasLiveVideo(camera)
    // Tapping the video shows it alone, larger, to pinch and zoom into.
    var expanded by rememberSaveable(camera.name) { mutableStateOf(false) }
    val zoom = remember(camera.name) { ZoomState() }
    val zoomable = expanded || landscape
    LaunchedEffect(zoomable) { if (!zoomable) zoom.reset() }
    BackHandler(enabled = expanded && !landscape) { expanded = false }
    var showSettings by rememberSaveable { mutableStateOf(false) }
    val hasSettings = (hasLive && streams.size > 1) || vm.controls.isAdmin

    ImmersiveEffect(landscape || expanded)

    // Leaving the app while live video plays keeps it going in a floating window.
    val pip = LocalPip.current
    val inPip = pip?.inPip == true
    DisposableEffect(pip, camera.name, hasLive) {
        pip?.offer(if (hasLive) camera.aspectRatio else null)
        onDispose { pip?.offer(null) }
    }

    val videoContent: @Composable (Modifier) -> Unit = { modifier ->
        Box(
            modifier
                .background(Color.Black)
                .onGloballyPositioned { coordinates ->
                    val box = coordinates.boundsInWindow()
                    pip?.videoBounds(Rect(box.left.toInt(), box.top.toInt(), box.right.toInt(), box.bottom.toInt()))
                },
        ) {
            val media = if (zoomable) {
                Modifier.zoomable(zoom)
            } else {
                Modifier.clickable(interactionSource = null, indication = null, onClickLabel = "Show larger") { expanded = true }
            }
            Box(Modifier.fillMaxSize().then(media)) {
                if (hasLive) {
                    LiveVideo(
                        session = session,
                        camera = camera.name,
                        stream = stream,
                        muted = muted,
                        onState = { liveState = it },
                        modifier = Modifier.fillMaxSize(),
                        route = vm.remoteAccess?.routeChanges ?: 0,
                    )
                } else {
                    LiveFrame(session.api, camera.name, intervalMs = 1_000, height = 720, modifier = Modifier.fillMaxSize())
                }
            }
            // The floating window is too small for controls; it has its own.
            if (inPip) return@Box
            val status = when {
                !hasLive || liveState == LiveState.FAILED -> "SNAPSHOT"
                liveState == LiveState.CONNECTING -> "CONNECTING"
                else -> "LIVE"
            }
            // Landscape puts the back button top-left, so the status moves out of its way.
            LivePill(
                label = status,
                live = status == "LIVE",
                modifier = Modifier
                    .align(if (landscape) Alignment.TopEnd else Alignment.TopStart)
                    .then(if (landscape) Modifier.safeDrawingPadding() else Modifier)
                    .padding(10.dp),
            )
            Row(
                Modifier.align(Alignment.BottomEnd).padding(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (hasLive) {
                    OverlayIconButton(
                        if (muted) Icons.AutoMirrored.Filled.VolumeOff else Icons.AutoMirrored.Filled.VolumeUp,
                        if (muted) "Unmute" else "Mute",
                        state = if (muted) "Muted" else "Sound on",
                    ) { muted = !muted }
                }
                pip?.takeIf { hasLive && it.supported }?.let { window ->
                    OverlayIconButton(Icons.Filled.PictureInPictureAlt, "Picture in picture") { window.enter() }
                }
                OverlayIconButton(
                    if (landscape) Icons.Filled.FullscreenExit else Icons.Filled.Fullscreen,
                    if (landscape) "Exit fullscreen" else "Fullscreen",
                ) { setFullscreen(!landscape) }
            }
        }
    }

    // The video moves between the layouts below rather than being made anew in each, so
    // turning the phone or entering the floating window does not reconnect the stream.
    val currentVideo by rememberUpdatedState(videoContent)
    val video = remember(camera.name) { movableContentOf { modifier: Modifier -> currentVideo(modifier) } }

    // The player fills its box, so the box takes the camera's shape, as large as fits and
    // centered on black, rather than stretching the picture to the screen's shape.
    if (inPip) {
        Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
            video(Modifier.aspectRatio(camera.aspectRatio))
        }
        return
    }

    if (landscape) {
        Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
            video(Modifier.aspectRatio(camera.aspectRatio))
            IconButton(
                onClick = { vm.nav.back() },
                modifier = Modifier.align(Alignment.TopStart).safeDrawingPadding().padding(4.dp),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
            }
        }
        return
    }

    // The header band and sheet of the tabs, with the video set into the band. Expanded,
    // the video fills the screen alone; it stays in the same place in the layout, so the
    // stream plays on rather than reconnecting.
    Column(Modifier.fillMaxSize().background(if (expanded) Color.Black else Palette.Chrome)) {
        if (!expanded) {
            DetailHeader(camera.label, onBack = { vm.nav.back() }) {
                if (hasSettings) {
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Outlined.Tune, contentDescription = "Camera settings")
                    }
                }
            }
        }
        BoxWithConstraints(
            Modifier.fillMaxWidth().then(if (expanded) Modifier.weight(1f) else Modifier.padding(horizontal = 12.dp)),
            contentAlignment = Alignment.Center,
        ) {
            // Portrait cameras would push everything else off screen, so cap the height.
            // Expanded, the video is as large as fits the screen, whichever side limits it.
            val heightFirst = camera.aspectRatio < 1f || (expanded && maxHeight < maxWidth / camera.aspectRatio)
            video(
                Modifier
                    .fillMaxWidth()
                    .then(if (expanded) Modifier else Modifier.heightIn(max = maxWidth * 1.1f))
                    .aspectRatio(camera.aspectRatio, matchHeightConstraintsFirst = heightFirst)
                    .then(if (expanded) Modifier else Modifier.clip(RoundedCornerShape(20.dp))),
            )
            if (expanded) {
                IconButton(
                    onClick = { expanded = false },
                    modifier = Modifier.align(Alignment.TopStart).safeDrawingPadding().padding(4.dp),
                ) {
                    Icon(Icons.Filled.Close, contentDescription = "Close", tint = Color.White)
                }
            }
        }
        if (!expanded) {
            TabSheet(Modifier.padding(top = 12.dp)) {
                CameraActivity(vm, session, camera, imageLoader)
            }
        }
    }

    if (showSettings) {
        CameraSettingsSheet(
            vm,
            camera,
            streamNames = if (hasLive) streamNames else emptyList(),
            streamIndex = streamIndex,
            onStream = { streamIndex = it },
            onDismiss = { showSettings = false },
        )
    }
}

/** The camera's figures, recordings and last day of activity, under its video. */
@Composable
private fun CameraActivity(vm: AppViewModel, session: Session, camera: Camera, imageLoader: ImageLoader) {
    val events = vm.reviewsFor(camera.name)
    val now = LocalNow.current
    LazyColumn(Modifier.fillMaxSize(), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Stat("Alerts", events.count { it.isAlert }.toString(), Palette.Alert, Modifier.weight(1f)) {
                    vm.showReviews(camera.name, Severity.ALERT)
                }
                Stat("Detections", events.count { !it.isAlert }.toString(), Palette.Detection, Modifier.weight(1f)) {
                    vm.showReviews(camera.name, Severity.DETECTION)
                }
                Stat(
                    "Last activity",
                    // "12m", "3h" or "now": a full "12m ago" does not fit a third of the width.
                    events.maxOfOrNull { it.startTime }?.let { timeAgo(it, now).removeSuffix(" ago").replace("just now", "now") } ?: "None",
                    Palette.TextPrimary,
                    Modifier.weight(1f),
                )
            }
        }
        item {
            SectionLabel("Recordings", Modifier.padding(start = 20.dp, end = 16.dp, top = 14.dp))
            // Four chips do not fit a phone's width, so the row scrolls.
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AssistChip(
                    onClick = { vm.nav.push(Overlay.Timeline(camera.name, System.currentTimeMillis() / 1000 - TIMELINE_START_SECONDS)) },
                    label = { Text("Timeline") },
                    leadingIcon = { Icon(Icons.Outlined.Timeline, null, Modifier.size(AssistChipDefaults.IconSize)) },
                )
                listOf(15 to "Last 15 min", 60 to "Last hour", 360 to "Last 6 hours").forEach { (minutes, label) ->
                    AssistChip(
                        onClick = { vm.nav.openRecording(camera.name, minutes) },
                        label = { Text(label) },
                        leadingIcon = { Icon(Icons.Outlined.History, null, Modifier.size(AssistChipDefaults.IconSize)) },
                    )
                }
            }
        }
        item {
            SectionLabel("Activity · last 24 hours", Modifier.padding(start = 20.dp, end = 16.dp, top = 14.dp, bottom = 6.dp))
        }
        if (events.isEmpty()) {
            item {
                EmptyState(
                    Icons.Outlined.NightsStay,
                    "All quiet",
                    detail = "Nothing happened here in the last 24 hours.",
                )
            }
        }
        items(events, key = { it.id }) { item ->
            ReviewRow(
                item,
                vm.cameraLabel(item.camera),
                session,
                imageLoader,
                showCamera = false,
                trackReviews = vm.trackReviews,
                onSwipe = { vm.swipeReviewed(item) },
            ) {
                vm.openEvent(item)
            }
        }
    }
}

/** A figure for the last 24 hours; tapping one with [onClick] lists its items. */
@Composable
internal fun Stat(label: String, value: String, color: Color, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    Column(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .background(Palette.Surface)
            .then(if (onClick != null) Modifier.clickable(onClickLabel = "Show $label", onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(
            value,
            style = MaterialTheme.typography.titleLarge.merge(Tabular),
            color = color,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
        Text(label, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary, maxLines = 1)
    }
}

/** An icon button over video; [state] is read out by TalkBack for toggles, such as "Muted". */
@Composable
fun OverlayIconButton(icon: ImageVector, description: String, state: String? = null, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = if (state != null) Modifier.semantics { stateDescription = state } else Modifier) {
        Icon(
            icon,
            contentDescription = description,
            tint = Color.White,
            modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Color(0x99000000)).padding(5.dp),
        )
    }
}

/** The timeline opens a few minutes back, where there is something recorded to play. */
private const val TIMELINE_START_SECONDS = 300L
