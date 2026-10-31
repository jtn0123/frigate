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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.Session

/** Up to four cameras live at once, two by two, each on its lighter stream. */
@Composable
fun LiveGridScreen(vm: AppViewModel, session: Session, chosen: List<String>) {
    val all = (vm.cameras as? Remote.Ready)?.value.orEmpty().filter { it.enabled }
    val shown = liveGridCameras(all, chosen)
    var picking by rememberSaveable { mutableStateOf(false) }
    val landscape = isLandscape()
    ImmersiveEffect(landscape)

    val gridContent: @Composable (Modifier) -> Unit = { modifier ->
        BoxWithConstraints(modifier) {
            // Fill the space: in landscape the height decides each tile's width.
            val across = (maxWidth - GAP) / 2
            val tileWidth = if (landscape) minOf(across, (maxHeight - GAP) / 2 * TILE_ASPECT) else across
            Column(Modifier.align(Alignment.Center), verticalArrangement = Arrangement.spacedBy(GAP)) {
                shown.chunked(2).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(GAP)) {
                        row.forEach { camera ->
                            LiveTile(vm, session, camera, Modifier.width(tileWidth).aspectRatio(TILE_ASPECT)) {
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
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Color.White)
            }
        }
    } else {
        Column(Modifier.fillMaxSize().background(Palette.Chrome)) {
            DetailHeader("Live", onBack = { vm.nav.back() }) {
                IconButton(onClick = { picking = true }) { Icon(Icons.Outlined.Edit, contentDescription = "Choose cameras") }
            }
            TabSheet {
                grid(Modifier.fillMaxWidth().padding(12.dp))
                Spacer(Modifier.weight(1f))
                Text(
                    "Tap a camera to open it. Each shows its lighter stream to save data.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextSecondary,
                    modifier = Modifier.navigationBarsPadding().padding(20.dp),
                )
            }
        }
    }

    if (picking) {
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
private fun LiveTile(vm: AppViewModel, session: Session, camera: Camera, modifier: Modifier, onClick: () -> Unit) {
    var state by rememberSaveable(camera.name) { mutableStateOf(LiveState.CONNECTING) }
    val hasLive = vm.hasLiveVideo(camera)
    Box(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Color.Black)
            .clickable(onClickLabel = "Open ${camera.label}", onClick = onClick),
    ) {
        // Each camera keeps its own shape inside the tile, letterboxed, rather than stretched.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            val fit = Modifier.aspectRatio(camera.aspectRatio)
            if (hasLive) {
                // The last stream is the lighter one when a camera has two.
                LiveVideo(session, camera.name, camera.liveStreams.values.lastOrNull() ?: camera.name, muted = true, fit) {
                    state = it
                }
            } else {
                LiveFrame(session.api, camera.name, intervalMs = 2_000, height = 360, modifier = fit)
            }
        }
        Row(Modifier.align(Alignment.TopStart).padding(6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OverlayTag(camera.label)
        }
        if (!hasLive || state != LiveState.PLAYING) {
            LivePill(
                if (!hasLive || state == LiveState.FAILED) "SNAPSHOT" else "CONNECTING",
                live = false,
                Modifier.align(Alignment.BottomStart).padding(6.dp),
            )
        }
    }
}

/** Checkboxes for up to four cameras. */
@Composable
private fun CameraPicker(all: List<Camera>, current: List<String>, onDismiss: () -> Unit, onDone: (List<String>) -> Unit) {
    var selected by rememberSaveable { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Choose up to $MAX_LIVE") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                all.forEach { camera ->
                    val checked = camera.name in selected
                    val enabled = checked || selected.size < MAX_LIVE
                    Row(
                        Modifier
                            .fillMaxWidth()
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
        confirmButton = { TextButton(onClick = { onDone(selected) }, enabled = selected.isNotEmpty()) { Text("Show") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private const val MAX_LIVE = 4
private const val TILE_ASPECT = 16f / 9f
private val GAP = 8.dp
