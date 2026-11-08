package com.jtn.frigateviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.VideocamOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.Session

/**
 * Up to four cameras live at once, two by two, each on its lighter stream. While
 * [covered] by a camera opened from it, its streams stay open but show nothing.
 */
@Composable
fun LiveGridScreen(vm: AppViewModel, session: Session, chosen: List<String>, covered: Boolean = false) {
    val cameras = vm.cameras
    val all = (cameras as? Remote.Ready)?.value.orEmpty().filter { it.enabled }
    if (cameras !is Remote.Ready || all.isEmpty()) {
        // Loading, failed with a Retry, or nothing to show: said, rather than an empty sheet.
        Column(Modifier.fillMaxSize().background(Palette.Chrome)) {
            DetailHeader(stringResource(R.string.cam_live_title), onBack = { vm.nav.back() })
            TabSheet {
                RemoteContent(cameras, onRetry = vm::refreshCameras) {
                    EmptyState(
                        Icons.Outlined.VideocamOff,
                        stringResource(R.string.cam_live_none),
                        detail = stringResource(R.string.cam_live_none_detail),
                        action = EmptyAction(stringResource(R.string.refresh)) { vm.refreshCameras() },
                    )
                }
            }
        }
        return
    }
    val shown = liveGridCameras(all, chosen)
    var picking by rememberSaveable { mutableStateOf(false) }
    val landscape = isLandscape()
    // Covered, the screen above has the bars; uncovered, they are hidden again.
    ImmersiveEffect(landscape && !covered)

    val gridContent: @Composable (Modifier) -> Unit = { modifier ->
        BoxWithConstraints(modifier) {
            // Fill the space: in landscape the height decides each tile's width.
            val across = (maxWidth - GAP) / 2
            val tileWidth = if (landscape) minOf(across, (maxHeight - GAP) / 2 * TILE_ASPECT) else across
            Column(Modifier.align(Alignment.Center), verticalArrangement = Arrangement.spacedBy(GAP)) {
                shown.chunked(2).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(GAP)) {
                        row.forEach { camera ->
                            LiveTile(vm, session, camera, covered, Modifier.width(tileWidth).aspectRatio(TILE_ASPECT)) {
                                vm.nav.openCamera(camera.name)
                            }
                        }
                    }
                }
            }
        }
    }

    // The grid moves between the two layouts rather than being made anew in each, so
    // turning the phone does not reconnect every stream.
    val currentGrid by rememberUpdatedState(gridContent)
    val grid = remember { movableContentOf { modifier: Modifier -> currentGrid(modifier) } }

    if (landscape) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            grid(Modifier.fillMaxSize().safeDrawingPadding())
            IconButton(onClick = { vm.nav.back() }, modifier = Modifier.safeDrawingPadding().padding(4.dp)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.cam_back), tint = Color.White)
            }
        }
    } else {
        Column(Modifier.fillMaxSize().background(Palette.Chrome)) {
            DetailHeader(stringResource(R.string.cam_live_title), onBack = { vm.nav.back() }) {
                IconButton(onClick = { picking = true }) {
                    Icon(Icons.Outlined.Edit, contentDescription = stringResource(R.string.cam_live_choose))
                }
            }
            TabSheet {
                grid(Modifier.fillMaxWidth().padding(12.dp))
                Spacer(Modifier.weight(1f))
                Text(
                    stringResource(R.string.cam_live_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextSecondary,
                    modifier = Modifier.navigationBarsPadding().padding(20.dp),
                )
            }
        }
    }

    if (picking && !covered) {
        CameraPicker(all, shown.map { it.name }, onDismiss = { picking = false }) { names ->
            picking = false
            vm.nav.replace(Overlay.LiveGrid(names))
        }
    }
}

/** The chosen cameras still available, or the first four when none are. */
internal fun liveGridCameras(all: List<Camera>, chosen: List<String>): List<Camera> =
    chosen.mapNotNull { name -> all.firstOrNull { it.name == name } }.take(MAX_LIVE).ifEmpty { all.take(MAX_LIVE) }

@Composable
private fun LiveTile(vm: AppViewModel, session: Session, camera: Camera, covered: Boolean, modifier: Modifier, onClick: () -> Unit) {
    var state by rememberSaveable(camera.name) { mutableStateOf(LiveState.CONNECTING) }
    val hasLive = vm.hasLiveVideo(camera)
    val openLabel = stringResource(R.string.cam_open, camera.label)
    Box(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Color.Black)
            .clickable(onClickLabel = openLabel, onClick = onClick),
    ) {
        // Each camera keeps its own shape inside the tile, letterboxed, rather than stretched.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            val fit = Modifier.aspectRatio(camera.aspectRatio)
            if (hasLive) {
                LiveVideo(
                    session,
                    camera.name,
                    lightStream(camera),
                    muted = true,
                    fit,
                    route = vm.remoteAccess?.routeChanges ?: 0,
                    covered = covered,
                ) {
                    state = it
                }
            } else {
                FittedLiveFrame(session.api, camera.name, intervalMs = 2_000, modifier = fit, active = !covered)
            }
        }
        Row(Modifier.align(Alignment.TopStart).padding(6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OverlayTag(camera.label)
        }
        if (!hasLive || state != LiveState.PLAYING) {
            LivePill(
                stringResource(if (!hasLive || state == LiveState.FAILED) R.string.cam_status_snapshot else R.string.cam_status_connecting),
                live = false,
                Modifier.align(Alignment.BottomStart).padding(6.dp),
            )
        }
    }
}

/**
 * The stream a tile plays, the lightest to decode four at once, chosen from what
 * the config says of each rather than from where it is listed: one named as the
 * sub or low stream, else the lowest resolution a name gives (as "360p" or
 * "640x360"), else one not named as the main or high stream. With nothing to tell
 * them apart, the last, as Frigate's examples list the main stream first.
 */
internal fun lightStream(camera: Camera): String {
    val streams = camera.liveStreams.entries.toList().ifEmpty { return camera.name }
    // The camera's own name says nothing of a stream: "low_garage_sub" is the garage's sub stream.
    val own = words(camera.name) + words(camera.label)
    val described = streams.map { it to (words(it.key) + words(it.value) - own) }
    val light = described.firstOrNull { (_, said) -> said.any(LIGHT_WORDS::contains) }?.first
        ?: streams.mapNotNull { stream -> heightIn(stream.key, stream.value)?.let { stream to it } }.minByOrNull { it.second }?.first
        ?: described.lastOrNull { (_, said) -> said.none(MAIN_WORDS::contains) }?.first
        ?: streams.last()
    return light.value
}

/** The words of a stream's label or name, lower case: "Sub Stream", "front_sub" and "frontSub" all have "sub". */
private fun words(text: String): Set<String> =
    WORD.findAll(text.replace(CAMEL, "$1 $2").lowercase()).map { it.value }.toSet()

/** The smallest picture height either of [texts] gives, as "360p" or "640x360", or null when neither does. */
private fun heightIn(vararg texts: String): Int? = texts.flatMap { text ->
    HEIGHT.findAll(text.lowercase()).mapNotNull { match -> (match.groups[1] ?: match.groups[2])?.value?.toIntOrNull() }
}.minOrNull()

private val WORD = Regex("[a-z]+")
private val CAMEL = Regex("([a-z])([A-Z])")
private val HEIGHT = Regex("""(?<![0-9])\d{3,4}x(\d{3,4})(?![0-9])|(?<![0-9])(\d{3,4})p(?![a-z])""")

/** Words naming the lighter stream. */
private val LIGHT_WORDS =
    setOf("sub", "substream", "low", "lowres", "lo", "lq", "sd", "lite", "light", "small", "mobile", "preview", "secondary")

/** Words naming the full-resolution stream. */
private val MAIN_WORDS = setOf("main", "mainstream", "high", "highres", "hi", "hq", "hd", "fhd", "uhd", "full", "primary", "record")

/** Checkboxes for up to four cameras. */
@Composable
private fun CameraPicker(all: List<Camera>, current: List<String>, onDismiss: () -> Unit, onDone: (List<String>) -> Unit) {
    var selected by rememberSaveable { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.cam_live_choose_up_to, MAX_LIVE)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                all.forEach { camera ->
                    val checked = camera.name in selected
                    val enabled = checked || selected.size < MAX_LIVE
                    // The checkbox only shows the state, so it adds no touch target of its own: the row is one.
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .toggleable(checked, enabled = enabled, role = Role.Checkbox) { on ->
                                selected = if (on) selected + camera.name else selected - camera.name
                            }
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
                        Text(camera.label, modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onDone(selected) }, enabled = selected.isNotEmpty()) { Text(stringResource(R.string.cam_live_show)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

private const val MAX_LIVE = 4
private const val TILE_ASPECT = 16f / 9f
private val GAP = 8.dp
