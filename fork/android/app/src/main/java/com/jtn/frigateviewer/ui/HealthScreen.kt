package com.jtn.frigateviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material.icons.outlined.VideocamOff
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.jtn.frigateviewer.data.CameraStats
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ServerStats
import com.jtn.frigateviewer.data.StorageStats
import com.jtn.frigateviewer.data.isNewerRelease
import java.util.Locale
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

/** Uptime, load, detector speed and each camera's frame rates, refreshed while on screen. */
@Composable
fun HealthScreen(vm: AppViewModel) {
    var stats by remember { mutableStateOf<Remote<ServerStats>>(Remote.Loading) }
    var attempt by remember { mutableStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(attempt) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                val next = vm.fetch { it.stats() }
                // A failed refresh keeps the last figures rather than blanking the screen.
                if (next is Remote.Ready || stats !is Remote.Ready) stats = next
                delay(HEALTH_REFRESH_MS)
            }
        }
    }

    Column(Modifier.fillMaxSize().background(Palette.Chrome)) {
        DetailHeader("Server health", onBack = { vm.nav.back() })
        TabSheet {
            RemoteContent(stats, onRetry = {
                stats = Remote.Loading
                attempt++
            }) { HealthContent(vm, it) }
        }
    }
}

@Composable
private fun HealthContent(vm: AppViewModel, stats: ServerStats) {
    // A few dozen rows at most, so one scrolling column rather than a lazy list.
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Stat("Uptime", stats.uptimeSeconds?.let(::formatUptime) ?: "—", Palette.TextPrimary, Modifier.weight(1f))
            Stat("CPU", percent(stats.cpuPercent), loadColor(stats.cpuPercent), Modifier.weight(1f))
            Stat("Memory", percent(stats.memoryPercent), loadColor(stats.memoryPercent), Modifier.weight(1f))
        }
        stats.version?.let { version ->
            val update = stats.latestVersion?.takeIf { isNewerRelease(it, version) }
            Text(
                "Frigate $version" + (update?.let { " · $it available" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                color = if (update != null) Palette.AccentText else Palette.TextSecondary,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
            )
        }
        if (stats.detectors.isNotEmpty() || stats.gpus.isNotEmpty()) {
            Section("Detection") {
                stats.detectors.forEach { detector ->
                    HealthRow(
                        Icons.Outlined.Speed,
                        detector.name,
                        detector.inferenceMs?.let { "${decimal(it)} ms per frame" } ?: "No figure yet",
                    )
                }
                stats.gpus.forEach { gpu ->
                    HealthRow(
                        Icons.Outlined.Memory,
                        gpu.name,
                        "GPU ${percent(gpu.usagePercent)}" + (gpu.memoryPercent?.let { " · memory ${percent(it)}" } ?: ""),
                    )
                }
            }
        }
        if (stats.cameras.isNotEmpty()) {
            Section("Cameras") {
                stats.cameras.forEach { CameraRow(vm.cameraLabel(it.name), it) }
            }
        }
        if (stats.storage.isNotEmpty()) {
            Section("Storage") {
                stats.storage.forEach { StorageRow(it) }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 20.dp)) {
        Group(title) { content() }
    }
}

@Composable
private fun HealthRow(
    icon: ImageVector,
    title: String,
    detail: String,
    tint: Color = Palette.TextSecondary,
    detailColor: Color = Palette.TextSecondary,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(detail, style = MaterialTheme.typography.bodyMedium.merge(Tabular), color = detailColor)
        }
    }
}

/** A camera sending nothing is shown as offline; one dropping frames says how many. */
@Composable
private fun CameraRow(label: String, camera: CameraStats) {
    val offline = camera.cameraFps <= 0.0
    // An occasional dropped frame is normal; a tenth of them is worth a look.
    val dropping = camera.skippedFps > camera.cameraFps * DROPPING
    val detail = when {
        offline -> "No frames coming in"
        else -> buildString {
            append("${decimal(camera.cameraFps)} fps in · ${decimal(camera.processFps)} processed")
            if (camera.skippedFps >= SKIPPED_SHOWN) append(" · ${decimal(camera.skippedFps)} skipped")
            if (!camera.detectionEnabled) append(" · detection off")
        }
    }
    HealthRow(
        if (offline) Icons.Outlined.VideocamOff else Icons.Outlined.Videocam,
        label,
        detail,
        tint = if (offline) Palette.Alert else Palette.TextSecondary,
        detailColor = if (offline || dropping) Palette.Alert else Palette.TextSecondary,
    )
}

@Composable
private fun StorageRow(storage: StorageStats) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(storage.mount, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Text(
                "${size(storage.usedMb)} of ${size(storage.totalMb)}",
                style = MaterialTheme.typography.bodyMedium.merge(Tabular),
                color = Palette.TextSecondary,
            )
        }
        LinearProgressIndicator(
            progress = { storage.usedFraction },
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)),
            color = if (storage.usedFraction > STORAGE_WARN) Palette.Alert else Palette.Accent,
            trackColor = Palette.Outline,
            drawStopIndicator = {},
        )
    }
}

/** "3d 4h", "5h 12m" or "8m". */
internal fun formatUptime(seconds: Long): String {
    val days = seconds / 86_400
    val hours = seconds % 86_400 / 3_600
    val minutes = seconds % 3_600 / 60
    return when {
        days > 0 -> "${days}d ${hours}h"
        hours > 0 -> "${hours}h ${minutes}m"
        else -> "${minutes}m"
    }
}

/** MiB as "512 MB", "3.4 GB" or "1.2 TB". */
internal fun size(mb: Double): String = when {
    mb >= MIB_PER_TIB -> "${decimal(mb / MIB_PER_TIB)} TB"
    mb >= MIB_PER_GIB -> "${decimal(mb / MIB_PER_GIB)} GB"
    else -> "${mb.toLong()} MB"
}

private fun percent(value: Double?): String = value?.let { "${it.roundToInt()}%" } ?: "—"

private fun decimal(value: Double): String = String.format(Locale.US, "%.1f", value).removeSuffix(".0")

@Composable
private fun loadColor(percent: Double?): Color = if ((percent ?: 0.0) >= HIGH_LOAD) Palette.Alert else Palette.TextPrimary

private const val HEALTH_REFRESH_MS = 15_000L
private const val HIGH_LOAD = 85.0
private const val DROPPING = 0.1
private const val SKIPPED_SHOWN = 0.05
private const val STORAGE_WARN = 0.9f
private const val MIB_PER_GIB = 1024.0
private const val MIB_PER_TIB = 1024.0 * 1024.0
