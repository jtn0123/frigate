package com.jtn.frigateviewer.ui

import android.view.LayoutInflater
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Done
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.SkipNext
import androidx.compose.material.icons.outlined.SkipPrevious
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.reviewVodUrl
import com.jtn.frigateviewer.data.vodUrl
import kotlinx.coroutines.delay

/** A review item's recording, with what happened and previous/next navigation. */
@Composable
fun EventScreen(vm: AppViewModel, session: Session, item: ReviewItem) {
    val camera = vm.cameraByName(item.camera)
    // Navigate within whatever list the user came from: the camera's activity
    // when opened from a camera, otherwise the current review filter.
    val list = if (vm.nav.overlays.any { it is Overlay.CameraDetail }) vm.reviewsFor(item.camera) else vm.filteredReviews
    val (older, newer) = adjacentReviews(list, item)

    PlaybackLayout(
        vm = vm,
        // An ongoing event's range ends "now"; fix it per item and end time so
        // recomposing does not restart the player.
        url = remember(item.id, item.endTime) { session.api.reviewVodUrl(item) },
        session = session,
        aspectRatio = camera?.aspectRatio ?: (16f / 9f),
        title = vm.cameraLabel(item.camera),
        actions = {
            if (vm.clips.available) {
                IconButton(onClick = { vm.clips.shareSnapshot(session.api, item, vm.cameraLabel(item.camera)) }) {
                    Icon(Icons.Outlined.Share, contentDescription = "Share snapshot")
                }
                val busy = vm.clips.states[item.id].let { it == ClipState.Preparing || it == ClipState.Downloading }
                // An ongoing item has no end to cut the clip at yet.
                IconButton(
                    onClick = { vm.clips.save(session.api, item, vm.cameraLabel(item.camera)) },
                    enabled = !item.isOngoing && !busy,
                ) {
                    Icon(Icons.Outlined.Download, contentDescription = "Save clip")
                }
            }
            // With "mark reviewed when opened" on, it already is; otherwise this is the way to.
            if (vm.trackReviews && !item.reviewed) {
                IconButton(onClick = { vm.markReviewed(item) }) {
                    Icon(Icons.Outlined.Done, contentDescription = "Mark reviewed")
                }
            }
        },
        // Stepping through items stays in reach of the thumb however long the details run.
        bottomBar = {
            OutlinedButton(
                onClick = { older?.let(vm::showEvent) },
                enabled = older != null,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.TextPrimary),
                modifier = Modifier.weight(1f),
            ) {
                Icon(Icons.Outlined.SkipPrevious, contentDescription = null)
                Text("Older")
            }
            OutlinedButton(
                onClick = { newer?.let(vm::showEvent) },
                enabled = newer != null,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.TextPrimary),
                modifier = Modifier.weight(1f),
            ) {
                Text("Newer")
                Icon(Icons.Outlined.SkipNext, contentDescription = null)
            }
        },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(item.title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
            if (vm.trackReviews && item.reviewed) {
                Pill("Reviewed", Palette.TextSecondary)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Pill(
                if (item.isAlert) "Alert" else "Detection",
                if (item.isAlert) Palette.Alert else Palette.Detection,
                dot = true,
            )
            Text(eventWhen(item), style = MaterialTheme.typography.bodyMedium.merge(Tabular), color = Palette.TextSecondary)
        }
        if (item.data.zones.isNotEmpty()) {
            SectionLabel("Zones")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                item.data.zones.forEach { zone -> Chip(zone.replace('_', ' ')) }
            }
        }
        vm.clips.states[item.id]?.let { state -> ClipStatus(state, onShare = { vm.clips.shareClip(item) }) }
        if (camera != null && vm.nav.overlays.none { it is Overlay.CameraDetail }) {
            OutlinedButton(
                onClick = { vm.nav.openCamera(camera.name) },
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.TextPrimary),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Outlined.Videocam, contentDescription = null)
                Text("  Watch ${camera.label} live")
            }
        }
    }
}

/** A continuous stretch of recordings ending when it was opened. */
@Composable
fun RecordingScreen(vm: AppViewModel, session: Session, camera: Camera, minutes: Int, end: Long) {
    val start = end - minutes * 60L
    val label = if (minutes < 60) "Last $minutes minutes" else "Last ${minutes / 60} hour${if (minutes > 60) "s" else ""}"
    PlaybackLayout(
        vm = vm,
        url = session.api.vodUrl(camera.name, start, end),
        session = session,
        aspectRatio = camera.aspectRatio,
        title = camera.label,
    ) {
        Text(label, style = MaterialTheme.typography.headlineSmall)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Fact("From", formatClock(start.toDouble()), Modifier.weight(1f))
            Fact("To", formatClock(end.toDouble()), Modifier.weight(1f))
        }
    }
}

/** Video on top and details below in portrait; video alone, fullscreen, in landscape. */
@Composable
internal fun PlaybackLayout(
    vm: AppViewModel,
    url: String,
    session: Session,
    aspectRatio: Float,
    title: String,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: (@Composable RowScope.() -> Unit)? = null,
    onPosition: ((Long) -> Unit)? = null,
    details: @Composable () -> Unit,
) {
    val landscape = isLandscape()
    val setFullscreen = rememberFullscreenToggle()
    ImmersiveEffect(landscape)

    if (landscape) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            VodPlayer(session, url, Modifier.fillMaxSize(), onPosition)
            Row(Modifier.safeDrawingPadding().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { vm.nav.back() }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
                }
                Text(title, color = Color.White, style = MaterialTheme.typography.titleMedium)
            }
            Box(Modifier.align(Alignment.TopEnd).safeDrawingPadding()) {
                OverlayIconButton(Icons.Filled.FullscreenExit, "Exit fullscreen") { setFullscreen(false) }
            }
        }
        return
    }

    // The header band and sheet of the tabs, with the video set into the band.
    Column(Modifier.fillMaxSize().background(Palette.Chrome)) {
        DetailHeader(title, onBack = { vm.nav.back() }, actions = actions)
        Box(
            Modifier
                .padding(horizontal = 12.dp)
                .fillMaxWidth()
                .heightIn(max = 480.dp)
                .aspectRatio(aspectRatio, matchHeightConstraintsFirst = aspectRatio < 1f)
                .align(Alignment.CenterHorizontally)
                .clip(RoundedCornerShape(20.dp))
                .background(Color.Black),
        ) {
            VodPlayer(session, url, Modifier.fillMaxSize(), onPosition)
            Box(Modifier.align(Alignment.TopEnd)) {
                OverlayIconButton(Icons.Filled.Fullscreen, "Fullscreen") { setFullscreen(true) }
            }
        }
        TabSheet(Modifier.padding(top = 12.dp)) {
            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) { details() }
            Row(
                Modifier.fillMaxWidth().navigationBarsPadding().padding(
                    horizontal = 16.dp,
                    vertical = if (bottomBar !=
                        null
                    ) {
                        10.dp
                    } else {
                        0.dp
                    },
                ),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) { bottomBar?.invoke(this) }
        }
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun VodPlayer(session: Session, url: String, modifier: Modifier = Modifier, onPosition: ((Long) -> Unit)? = null) {
    val context = LocalContext.current
    var error by remember(url) { mutableStateOf<String?>(null) }
    val player = remember(url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaSource(
                HlsMediaSource.Factory(OkHttpDataSource.Factory(session.client)).createMediaSource(MediaItem.fromUri(url)),
            )
            playWhenReady = true
            prepare()
        }
    }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) {
                error = "This recording could not be played (${e.errorCodeName})"
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }
    if (onPosition != null) {
        // Milliseconds into the playlist, for a timeline to follow while it plays.
        LaunchedEffect(player) {
            while (true) {
                if (player.isPlaying) onPosition(player.currentPosition)
                delay(POSITION_INTERVAL_MS)
            }
        }
    }
    Box(modifier) {
        AndroidView(
            factory = { ctx ->
                LayoutInflater.from(ctx).inflate(R.layout.vod_player, FrameLayout(ctx), false) as PlayerView
            },
            update = { it.player = player },
            modifier = Modifier.fillMaxSize(),
        )
        error?.let {
            Text(it, color = Palette.Alert, textAlign = TextAlign.Center, modifier = Modifier.align(Alignment.Center).padding(24.dp))
        }
    }
}

/** How saving the clip is going, and a way to share it once saved. */
@Composable
private fun ClipStatus(state: ClipState, onShare: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Palette.Surface).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when (state) {
            ClipState.Preparing, ClipState.Downloading -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            is ClipState.Saved -> Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = Palette.Ok)
            is ClipState.Failed -> Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = Palette.Alert)
        }
        Text(
            when (state) {
                ClipState.Preparing -> "Frigate is preparing the clip…"
                ClipState.Downloading -> "Saving the clip…"
                is ClipState.Saved -> "Saved to Movies/Frigate"
                is ClipState.Failed -> "Could not save the clip (${state.message})"
            },
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (state is ClipState.Saved) {
            TextButton(onClick = onShare) { Text("Share") }
        }
    }
}

@Composable
private fun Fact(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(Palette.Surface).padding(12.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary)
        Text(value, style = MaterialTheme.typography.titleMedium.merge(Tabular))
    }
}

@Composable
private fun Chip(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Palette.SurfaceHigh).padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

/** A rounded tag in [color], with a dot when it names a severity. */
@Composable
private fun Pill(text: String, color: Color, dot: Boolean = false) {
    Row(
        Modifier.clip(CircleShape).background(color.copy(alpha = PILL_TINT)).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (dot) Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Text(text, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

/** When an item happened and for how long, on one line: "Today · 9:35:12 PM · 0:12 long". */
internal fun eventWhen(item: ReviewItem): String {
    val length = if (item.isOngoing) "in progress" else "${formatDuration(item.startTime, item.endTime)} long"
    return "${dayLabel(item.startTime)} · ${formatClock(item.startTime)} · $length"
}

private const val PILL_TINT = 0.16f
private const val POSITION_INTERVAL_MS = 250L
