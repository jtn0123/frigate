package com.jtn.frigateviewer.ui

import android.content.Context
import android.net.Uri
import android.net.VpnService
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.tunnel.RemoteAccess
import com.jtn.frigateviewer.tunnel.TUNNEL_FILE_MAX_BYTES
import com.jtn.frigateviewer.tunnel.TunnelStatus
import com.jtn.frigateviewer.tunnel.describeHost
import com.jtn.frigateviewer.tunnel.import
import com.jtn.frigateviewer.tunnel.remove
import com.jtn.frigateviewer.tunnel.setEnabled
import com.jtn.frigateviewer.tunnel.tunnelEndpoint
import com.jtn.frigateviewer.tunnel.tunnelServer
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The WireGuard tunnel for watching away from home: importing the file the
 * VPN server exports, turning it on or off, and how it stands.
 */
@Composable
fun RemoteAccessSettings(remote: RemoteAccess, onShowLog: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var problem by rememberSaveable { mutableStateOf<String?>(null) }
    var managing by rememberSaveable { mutableStateOf(false) }

    val allow = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { remote.check() }

    /** Asks Android for the VPN connection if it has not allowed it yet; it asks once. */
    fun askForPermission() {
        val request = VpnService.prepare(context)
        if (request != null) allow.launch(request) else remote.check()
    }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            problem = when (val file = readTunnelFile(context, uri)) {
                is PickedFile.Read -> remote.import(file.name, file.text)
                is PickedFile.Unreadable -> file.problem
            }
            if (problem == null) askForPermission()
        }
    }
    // WireGuard files have no registered type, so any file can be picked; the contents are checked.
    val chooseFile = { pick.launch(arrayOf("*/*")) }

    val tunnel = remote.tunnel
    if (tunnel == null) {
        Info(
            Icons.Outlined.VpnKey,
            "Set up WireGuard",
            "Import the .conf file from your WireGuard VPN server, such as a UniFi gateway's, to watch away from home.",
            onClick = chooseFile,
            actionLabel = "Choose the WireGuard file",
        )
    } else {
        Toggle(
            title = "Use away from home",
            description = statusText(remote.status),
            checked = tunnel.enabled,
            onChange = { on ->
                remote.setEnabled(on)
                if (on) askForPermission()
            },
            icon = Icons.Outlined.VpnKey,
        )
        if (remote.status == TunnelStatus.NeedsPermission) {
            Info(
                Icons.Outlined.Shield,
                "Allow the VPN connection",
                "Android asks once before the app can use its tunnel.",
                onClick = ::askForPermission,
                actionLabel = "Allow the VPN connection",
            )
        }
        (remote.status as? TunnelStatus.Failed)?.takeIf { it.noAnswer }?.let { NoAnswerChecks(tunnel.config) }
        // The server it dials, so a wrong address in the file can be spotted here.
        val endpoint = remember(tunnel.config) { tunnelEndpoint(tunnel.config) }
        Info(
            Icons.Outlined.Description,
            "Tunnel file",
            listOfNotNull(tunnel.name.ifEmpty { "Imported" }, endpoint?.let { "Server $it" }).joinToString(" · "),
            onClick = { managing = true },
            actionLabel = "Replace or remove the tunnel file",
        )
    }
    Info(Icons.AutoMirrored.Outlined.ReceiptLong, "Tunnel log", "What the tunnel did, to copy or share", onClick = onShowLog)
    problem?.let { ImportProblem(it) }

    if (managing) {
        AlertDialog(
            onDismissRequest = { managing = false },
            title = { Text("Tunnel file") },
            text = { Text("Only this app's connections go through the tunnel. Replace it with a new file, or remove it.") },
            confirmButton = {
                TextButton(onClick = {
                    managing = false
                    chooseFile()
                }) { Text("Replace") }
            },
            dismissButton = {
                TextButton(onClick = {
                    managing = false
                    problem = null
                    remote.remove()
                }) { Text("Remove", color = Palette.Alert) }
            },
        )
    }
}

/** Why the picked file was not used. */
@Composable
internal fun ImportProblem(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = Palette.Alert,
        // Said by TalkBack when it appears, since the file picker has just closed and focus is elsewhere.
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/**
 * What to check when the tunnel runs but the VPN server never answers: the
 * causes are on the gateway or the way to it, so the phone cannot see them.
 */
@Composable
private fun NoAnswerChecks(config: String) {
    val server = remember(config) { tunnelServer(config) }
    Column(Modifier.padding(start = 56.dp, end = 16.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        noAnswerChecks(server).forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary) }
    }
}

/** The checks, worded for the file's server [server] (host and port). */
internal fun noAnswerChecks(server: Pair<String, Int>?): List<String> {
    val (host, port) = server ?: return listOf("• The file names no server to connect to. Export it again.")
    val kind = describeHost(host)
    val unreachable = kind.contains("private") || kind.contains("carrier-grade")
    return listOfNotNull(
        "Things to check:",
        "• This phone's client is on the VPN server: saved (on UniFi, Apply Changes) before the file was downloaded, " +
            "and not deleted or re-created since. The server ignores a key it does not know without a word, " +
            "so a re-created client needs its new file.",
        "• The VPN server is on, and not paused or turned off on the gateway.",
        "• The file's server is $kind." +
            if (unreachable) " The internet cannot reach it, so export the file with your public address." else "",
        "• UDP port $port is open to the internet. Some mobile networks block UDP: try another Wi-Fi too.",
        "• The official WireGuard app connects with the same file. If it does not either, the cause is the server.",
    )
}

internal fun statusText(status: TunnelStatus): String = when (status) {
    TunnelStatus.NotSetUp, TunnelStatus.Off -> "Off. The app only connects directly."
    TunnelStatus.NeedsPermission -> "Waiting for Android to allow the VPN connection."
    TunnelStatus.Checking -> "Checking whether the server answers directly…"
    TunnelStatus.Home -> "The server answers directly, so the tunnel is off."
    TunnelStatus.NoNetwork -> "No network. It connects when there is one."
    TunnelStatus.Connecting -> "Away from home. Connecting…"
    TunnelStatus.Connected -> "Away from home, connected through the tunnel."
    is TunnelStatus.Failed -> "Not connected. ${status.message}"
}

/** A picked file, read, or why it could not be. */
internal sealed interface PickedFile {
    data class Read(val name: String, val text: String) : PickedFile

    data class Unreadable(val problem: String) : PickedFile
}

/** The picked file's name and text, or why it cannot be used: unreadable, or far too big to be a WireGuard file. */
internal suspend fun readTunnelFile(context: Context, uri: Uri): PickedFile = withContext(Dispatchers.IO) {
    val resolver = context.contentResolver
    try {
        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }.orEmpty()
        val bytes = resolver.openInputStream(uri)?.use { it.readAtMost(TUNNEL_FILE_MAX_BYTES + 1) }
        when {
            bytes == null -> PickedFile.Unreadable(UNREADABLE)
            bytes.size > TUNNEL_FILE_MAX_BYTES -> PickedFile.Unreadable(
                "That file is too big to be a WireGuard file, which is a few hundred bytes. Pick the .conf file.",
            )
            else -> PickedFile.Read(name, decodeTunnelFile(bytes))
        }
    } catch (_: IOException) {
        PickedFile.Unreadable(UNREADABLE)
    } catch (_: SecurityException) {
        PickedFile.Unreadable(UNREADABLE)
    }
}

/**
 * The file's text. Windows Notepad's "Unicode" saves UTF-16, which read as
 * UTF-8 would be unreadable, so its byte order mark picks the decoding.
 */
internal fun decodeTunnelFile(bytes: ByteArray): String = when {
    bytes.startsWith(0xFF, 0xFE) -> String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
    bytes.startsWith(0xFE, 0xFF) -> String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
    else -> bytes.decodeToString()
}

private fun ByteArray.startsWith(first: Int, second: Int) = size >= 2 && this[0] == first.toByte() && this[1] == second.toByte()

private const val UNREADABLE = "Could not read that file."

/** Up to [limit] bytes, so a huge file picked by mistake is not read whole. */
private fun InputStream.readAtMost(limit: Int): ByteArray {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(BUFFER_BYTES)
    while (out.size() < limit) {
        val read = read(buffer, 0, minOf(buffer.size, limit - out.size()))
        if (read < 0) break
        out.write(buffer, 0, read)
    }
    return out.toByteArray()
}

private const val BUFFER_BYTES = 8 * 1024
