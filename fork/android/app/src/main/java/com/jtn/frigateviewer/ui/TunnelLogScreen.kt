package com.jtn.frigateviewer.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.DeleteSweep
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.jtn.frigateviewer.BuildConfig
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.tunnel.RemoteAccess
import com.jtn.frigateviewer.tunnel.TunnelStats
import com.jtn.frigateviewer.tunnel.tunnelReport
import com.jtn.frigateviewer.tunnel.wireGuardLines
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the tunnel did, live, with its traffic, to copy or share as a report about the server at [baseUrl]. */
@Composable
fun TunnelLogScreen(remote: RemoteAccess, baseUrl: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val res = LocalResources.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(remote) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                remote.refreshStats()
                delay(2_000)
            }
        }
    }

    suspend fun report(): String = tunnelReport(
        remote,
        baseUrl,
        about = listOf(
            "App ${BuildConfig.VERSION_NAME} (${BuildConfig.BUILD_TYPE})",
            "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), ${Build.MANUFACTURER} ${Build.MODEL}",
        ),
        libraryLines = wireGuardLines(),
    )

    // Building the report takes a moment, and the share sheet another to open: a second
    // tap meanwhile would copy twice or open a second sheet.
    var busy by remember { mutableStateOf(false) }

    fun once(action: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                action()
                delay(SETTLE_MS)
            } finally {
                busy = false
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        TunnelLogContent(remote, busy, onBack, onCopy = {
            once {
                val text = report()
                context.getSystemService(ClipboardManager::class.java)
                    .setPrimaryClip(ClipData.newPlainText(res.getString(R.string.set_log_report_title), text))
            }
        }, onShare = {
            once {
                val send = Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, res.getString(R.string.set_log_report_title))
                    .putExtra(Intent.EXTRA_TEXT, report())
                context.startActivity(Intent.createChooser(send, null))
            }
        }, onClear = {
            val cleared = remote.log.clear()
            scope.launch {
                snackbar.currentSnackbarData?.dismiss()
                val result = snackbar.showSnackbar(
                    res.getString(R.string.set_log_cleared),
                    actionLabel = res.getString(R.string.set_log_undo),
                    duration = SnackbarDuration.Short,
                )
                if (result == SnackbarResult.ActionPerformed) remote.log.restore(cleared)
            }
        })
        AppSnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
    }
}

@Composable
private fun TunnelLogContent(
    remote: RemoteAccess,
    busy: Boolean,
    onBack: () -> Unit,
    onCopy: () -> Unit,
    onShare: () -> Unit,
    onClear: () -> Unit,
) {
    Column(Modifier.fillMaxSize().background(Palette.Chrome)) {
        DetailHeader(stringResource(R.string.set_wg_tunnel_log), onBack = onBack) {
            IconButton(enabled = !busy, onClick = onCopy) {
                Icon(Icons.Outlined.ContentCopy, contentDescription = stringResource(R.string.set_log_copy))
            }
            IconButton(enabled = !busy, onClick = onShare) {
                Icon(Icons.Outlined.Share, contentDescription = stringResource(R.string.set_log_share))
            }
            IconButton(onClick = onClear) { Icon(Icons.Outlined.DeleteSweep, contentDescription = stringResource(R.string.set_log_clear)) }
        }
        TabSheet {
            val entries = remote.log.entries
            val list = rememberLazyListState()
            // Follow the newest entry. Once the log is full its size stays put as the oldest
            // drop off, so the last entry, not the count, says when there is a new one.
            LaunchedEffect(entries.lastOrNull()) { if (entries.isNotEmpty()) list.scrollToItem(entries.size) }
            LazyColumn(
                Modifier.fillMaxSize(),
                state = list,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item {
                    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(statusText(remote.status).resolve(), style = MaterialTheme.typography.bodyLarge)
                        Text(trafficText(remote.stats).resolve(), style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary)
                    }
                }
                if (entries.isEmpty()) {
                    item {
                        Text(
                            stringResource(R.string.set_log_empty),
                            style = MaterialTheme.typography.bodyMedium,
                            color = Palette.TextSecondary,
                        )
                    }
                }
                val clock = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
                items(entries) { entry ->
                    Text("${clock.format(Date(entry.at))}  ${entry.text}", style = MonoSmall, color = Palette.TextPrimary)
                }
            }
        }
    }
}

/** How long Copy and Share stay off after one, while the share sheet opens. */
private const val SETTLE_MS = 1_000L

internal fun trafficText(stats: TunnelStats?, now: Long = System.currentTimeMillis()): UiText {
    if (stats == null) return uiText(R.string.tunnel_traffic_down)
    val handshake = stats.lastHandshakeMs?.let { uiText(R.string.tunnel_traffic_answered, (now - it) / 1_000) }
        ?: uiText(R.string.tunnel_traffic_not_answered)
    return uiText(R.string.tunnel_traffic, bytes(stats.sentBytes), bytes(stats.receivedBytes), handshake)
}

/** "1 byte" or "2048 bytes"; a count past an Int takes the plural form of a large one. */
private fun bytes(count: Long): UiText =
    UiText.Plural(R.plurals.bytes_count, count.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), listOf(count))
