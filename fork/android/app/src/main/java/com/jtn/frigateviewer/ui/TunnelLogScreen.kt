package com.jtn.frigateviewer.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.jtn.frigateviewer.BuildConfig
import com.jtn.frigateviewer.tunnel.RemoteAccess
import com.jtn.frigateviewer.tunnel.TunnelStats
import com.jtn.frigateviewer.tunnel.tunnelReport
import com.jtn.frigateviewer.tunnel.wireGuardLines
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the tunnel did, live, with its traffic, to copy or share as a report. */
@Composable
fun TunnelLogScreen(vm: AppViewModel, remote: RemoteAccess) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
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
        vm.savedSettings.baseUrl,
        about = listOf(
            "App ${BuildConfig.VERSION_NAME} (${BuildConfig.BUILD_TYPE})",
            "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}), ${Build.MANUFACTURER} ${Build.MODEL}",
        ),
        permitted = VpnService.prepare(context) == null,
        libraryLines = wireGuardLines(),
    )

    Column(Modifier.fillMaxSize().background(Palette.Chrome)) {
        DetailHeader("Tunnel log", onBack = { vm.nav.back() }) {
            IconButton(onClick = {
                scope.launch {
                    val text = report()
                    context.getSystemService(ClipboardManager::class.java)
                        .setPrimaryClip(ClipData.newPlainText("Frigate tunnel report", text))
                }
            }) { Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy report") }
            IconButton(onClick = {
                scope.launch {
                    val send = Intent(Intent.ACTION_SEND)
                        .setType("text/plain")
                        .putExtra(Intent.EXTRA_SUBJECT, "Frigate tunnel report")
                        .putExtra(Intent.EXTRA_TEXT, report())
                    context.startActivity(Intent.createChooser(send, null))
                }
            }) { Icon(Icons.Outlined.Share, contentDescription = "Share report") }
            IconButton(onClick = { remote.log.clear() }) { Icon(Icons.Outlined.DeleteSweep, contentDescription = "Clear log") }
        }
        TabSheet {
            val entries = remote.log.entries
            val list = rememberLazyListState()
            LaunchedEffect(entries.size) { if (entries.isNotEmpty()) list.scrollToItem(entries.size) }
            LazyColumn(
                Modifier.fillMaxSize(),
                state = list,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                item {
                    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(statusText(remote.status), style = MaterialTheme.typography.bodyLarge)
                        Text(trafficText(remote.stats), style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary)
                    }
                }
                if (entries.isEmpty()) {
                    item {
                        Text(
                            "Nothing yet. Open the app away from home, or change networks, and what the tunnel does shows here.",
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

internal fun trafficText(stats: TunnelStats?, now: Long = System.currentTimeMillis()): String {
    if (stats == null) return "Tunnel down"
    val handshake = stats.lastHandshakeMs?.let { "server answered ${(now - it) / 1_000} s ago" } ?: "server has not answered"
    return "Sent ${stats.sentBytes} bytes, received ${stats.receivedBytes} bytes · $handshake"
}
