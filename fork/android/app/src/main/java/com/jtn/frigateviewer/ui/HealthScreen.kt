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
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.CameraStats
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ServerStats
import com.jtn.frigateviewer.data.StorageStats
import com.jtn.frigateviewer.data.isNewerRelease
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Uptime, load, detector speed and each camera's frame rates. [follow] keeps
 * [stats] fresh, and runs while the screen shows and the app is in front.
 */
@Composable
fun HealthScreen(
    stats: Remote<ServerStats>,
    cameraLabel: (String) -> String,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    follow: suspend () -> Unit = {},
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val currentFollow by rememberUpdatedState(follow)
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { currentFollow() }
    }

    Column(Modifier.fillMaxSize().background(Palette.Chrome)) {
        DetailHeader(stringResource(R.string.set_server_health), onBack = onBack)
        TabSheet {
            RemoteContent(stats, onRetry = onRetry) { HealthContent(cameraLabel, it) }
        }
    }
}

@Composable
private fun HealthContent(cameraLabel: (String) -> String, stats: ServerStats) {
    // A few dozen rows at most, so one scrolling column rather than a lazy list.
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Stat(
                stringResource(R.string.set_health_uptime),
                stats.uptimeSeconds?.let { formatUptime(it).resolve() } ?: stringResource(R.string.set_no_figure),
                Palette.TextPrimary,
                Modifier.weight(1f),
            )
            Stat(
                stringResource(R.string.set_health_cpu),
                percent(stats.cpuPercent).resolve(),
                loadColor(stats.cpuPercent),
                Modifier.weight(1f),
            )
            Stat(
                stringResource(R.string.set_health_memory),
                percent(stats.memoryPercent).resolve(),
                loadColor(stats.memoryPercent),
                Modifier.weight(1f),
            )
        }
        stats.version?.let { version ->
            val update = stats.latestVersion?.takeIf { isNewerRelease(it, version) }
            Text(
                update?.let { stringResource(R.string.set_health_version_update, version, it) }
                    ?: stringResource(R.string.set_health_version, version),
                style = MaterialTheme.typography.bodySmall,
                color = if (update != null) Palette.AccentText else Palette.TextSecondary,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
            )
        }
        if (stats.detectors.isNotEmpty() || stats.gpus.isNotEmpty()) {
            Section(stringResource(R.string.set_health_detection)) {
                stats.detectors.forEach { detector ->
                    HealthRow(
                        Icons.Outlined.Speed,
                        detector.name,
                        detector.inferenceMs?.let { stringResource(R.string.set_health_inference, decimal(it)) }
                            ?: stringResource(R.string.set_health_no_figure),
                    )
                }
                stats.gpus.forEach { gpu ->
                    HealthRow(
                        Icons.Outlined.Memory,
                        gpu.name,
                        gpu.memoryPercent?.let {
                            stringResource(R.string.set_health_gpu_memory, percent(gpu.usagePercent).resolve(), percent(it).resolve())
                        } ?: stringResource(R.string.set_health_gpu, percent(gpu.usagePercent).resolve()),
                    )
                }
            }
        }
        if (stats.cameras.isNotEmpty()) {
            Section(stringResource(R.string.set_health_cameras)) {
                stats.cameras.forEach { CameraRow(cameraLabel(it.name), it) }
            }
        }
        if (stats.storage.isNotEmpty()) {
            Section(stringResource(R.string.set_health_storage)) {
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
    val rates = stringResource(R.string.set_health_fps, decimal(camera.cameraFps), decimal(camera.processFps))
    val skipped = stringResource(R.string.set_health_skipped, decimal(camera.skippedFps))
    val detectionOff = stringResource(R.string.set_health_detection_off)
    val detail = when {
        offline -> stringResource(R.string.set_health_no_frames)
        else -> buildString {
            append(rates)
            if (camera.skippedFps >= SKIPPED_SHOWN) append(skipped)
            if (!camera.detectionEnabled) append(detectionOff)
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
                stringResource(R.string.set_health_used_of, size(storage.usedMb).resolve(), size(storage.totalMb).resolve()),
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
internal fun formatUptime(seconds: Long): UiText {
    val days = seconds / 86_400
    val hours = seconds % 86_400 / 3_600
    val minutes = seconds % 3_600 / 60
    return when {
        days > 0 -> uiText(R.string.set_uptime_days, days, hours)
        hours > 0 -> uiText(R.string.set_uptime_hours, hours, minutes)
        else -> uiText(R.string.set_uptime_minutes, minutes)
    }
}

/** MiB as "512 MB", "3.4 GB" or "1.2 TB". */
internal fun size(mb: Double): UiText = when {
    mb >= MIB_PER_TIB -> uiText(R.string.set_size_tb, decimal(mb / MIB_PER_TIB))
    mb >= MIB_PER_GIB -> uiText(R.string.set_size_gb, decimal(mb / MIB_PER_GIB))
    else -> uiText(R.string.set_size_mb, mb.toLong().toString())
}

private fun percent(value: Double?): UiText = value?.let { uiText(R.string.set_percent, it.roundToInt()) } ?: uiText(R.string.set_no_figure)

private fun decimal(value: Double): String = String.format(Locale.US, "%.1f", value).removeSuffix(".0")

@Composable
private fun loadColor(percent: Double?): Color = if ((percent ?: 0.0) >= HIGH_LOAD) Palette.Alert else Palette.TextPrimary

internal const val HEALTH_REFRESH_MS = 15_000L
private const val HIGH_LOAD = 85.0
private const val DROPPING = 0.1
private const val SKIPPED_SHOWN = 0.05
private const val STORAGE_WARN = 0.9f
private const val MIB_PER_GIB = 1024.0
private const val MIB_PER_TIB = 1024.0 * 1024.0
