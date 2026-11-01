package com.jtn.frigateviewer.ui

import android.content.Context
import android.net.Uri
import android.net.VpnService
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.tunnel.RemoteAccess
import com.jtn.frigateviewer.tunnel.TUNNEL_FILE_MAX_BYTES
import com.jtn.frigateviewer.tunnel.TunnelStatus
import com.jtn.frigateviewer.tunnel.describeHost
import com.jtn.frigateviewer.tunnel.import
import com.jtn.frigateviewer.tunnel.remove
import com.jtn.frigateviewer.tunnel.setEnabled
import com.jtn.frigateviewer.tunnel.startTunnel
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
    var confirmRemove by rememberSaveable { mutableStateOf(false) }

    val allow = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { remote.check() }

    /**
     * Asks Android for the VPN connection if it has not allowed it yet; it asks
     * once. Not while another app's VPN is on: asking hands the VPN to this app
     * and turns that one off, so it is asked when the tunnel is needed instead.
     */
    fun askForPermission() {
        if (remote.otherVpnOn) return remote.check()
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
            stringResource(R.string.set_wg_set_up),
            stringResource(R.string.set_wg_set_up_detail),
            onClick = chooseFile,
            actionLabel = stringResource(R.string.set_wg_choose_file),
        )
    } else {
        Toggle(
            title = stringResource(R.string.set_wg_use_away),
            description = statusText(remote.status).resolve(),
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
                stringResource(R.string.set_wg_allow_vpn),
                stringResource(R.string.set_wg_allow_vpn_detail),
                onClick = ::askForPermission,
                actionLabel = stringResource(R.string.set_wg_allow_vpn),
            )
        }
        when (remote.status) {
            TunnelStatus.OtherVpnInTheWay -> Info(
                Icons.Outlined.VpnKey,
                stringResource(R.string.set_wg_use_app_tunnel),
                stringResource(R.string.set_wg_use_app_tunnel_detail),
                onClick = remote::startTunnel,
                actionLabel = stringResource(R.string.set_wg_use_app_tunnel),
            )
            TunnelStatus.StoppedOutside -> Info(
                Icons.Outlined.VpnKey,
                stringResource(R.string.set_wg_start_tunnel),
                stringResource(R.string.set_wg_start_tunnel_detail),
                onClick = remote::startTunnel,
                actionLabel = stringResource(R.string.set_wg_start_tunnel),
            )
            else -> Unit
        }
        (remote.status as? TunnelStatus.Failed)?.takeIf { it.noAnswer }?.let { NoAnswerChecks(tunnel.config) }
        // The server it dials, so a wrong address in the file can be spotted here.
        val endpoint = remember(tunnel.config) { tunnelEndpoint(tunnel.config) }
        val name = tunnel.name.ifEmpty { stringResource(R.string.set_wg_imported) }
        Info(
            Icons.Outlined.Description,
            stringResource(R.string.set_wg_tunnel_file),
            endpoint?.let { stringResource(R.string.set_wg_file_and_server, name, stringResource(R.string.set_wg_server, it)) } ?: name,
            onClick = { managing = true },
            actionLabel = stringResource(R.string.set_wg_replace_or_remove),
        )
    }
    Info(
        Icons.AutoMirrored.Outlined.ReceiptLong,
        stringResource(R.string.set_wg_tunnel_log),
        stringResource(R.string.set_wg_tunnel_log_detail),
        onClick = onShowLog,
    )
    problem?.let { ImportProblem(it) }

    if (managing) {
        AlertDialog(
            onDismissRequest = { managing = false },
            title = { Text(stringResource(R.string.set_wg_tunnel_file)) },
            text = { Text(stringResource(R.string.set_wg_manage_detail)) },
            confirmButton = {
                TextButton(onClick = {
                    managing = false
                    chooseFile()
                }) { Text(stringResource(R.string.set_wg_replace)) }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = { managing = false }) { Text(stringResource(R.string.cancel)) }
                    TextButton(onClick = {
                        managing = false
                        confirmRemove = true
                    }) { Text(stringResource(R.string.set_wg_remove), color = Palette.Alert) }
                }
            },
        )
    }

    if (confirmRemove) {
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text(stringResource(R.string.set_wg_remove_confirm)) },
            text = { Text(stringResource(R.string.set_wg_remove_detail)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmRemove = false
                    problem = null
                    remote.remove()
                }) { Text(stringResource(R.string.set_wg_remove), color = Palette.Alert) }
            },
            dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text(stringResource(R.string.cancel)) } },
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
        noAnswerChecks(server).forEach { Text(it.resolve(), style = MaterialTheme.typography.bodySmall, color = Palette.TextSecondary) }
    }
}

/** The checks, worded for the file's server [server] (host and port). */
internal fun noAnswerChecks(server: Pair<String, Int>?): List<UiText> {
    val (host, port) = server ?: return listOf(uiText(R.string.set_check_no_server))
    val kind = describeHost(host)
    val unreachable = kind.contains("private") || kind.contains("carrier-grade")
    return listOf(
        uiText(R.string.set_check_title),
        uiText(R.string.set_check_client),
        uiText(R.string.set_check_server_on),
        uiText(if (unreachable) R.string.set_check_server_unreachable else R.string.set_check_server_kind, kind),
        uiText(R.string.set_check_udp, port),
        uiText(R.string.set_check_official_app),
    )
}

internal fun statusText(status: TunnelStatus): UiText = when (status) {
    TunnelStatus.NotSetUp, TunnelStatus.Off -> uiText(R.string.set_status_off)
    TunnelStatus.NeedsPermission -> uiText(R.string.set_status_needs_permission)
    TunnelStatus.Checking -> uiText(R.string.set_status_checking)
    TunnelStatus.Home -> uiText(R.string.set_status_home)
    TunnelStatus.OtherVpn -> uiText(R.string.set_status_other_vpn)
    TunnelStatus.OtherVpnInTheWay -> uiText(R.string.set_status_other_vpn_in_the_way)
    TunnelStatus.StoppedOutside -> uiText(R.string.set_status_stopped_outside)
    TunnelStatus.NoNetwork -> uiText(R.string.set_status_no_network)
    TunnelStatus.Connecting -> uiText(R.string.set_status_connecting)
    TunnelStatus.Connected -> uiText(R.string.set_status_connected)
    is TunnelStatus.Failed -> uiText(R.string.set_status_failed, status.message)
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
            bytes == null -> PickedFile.Unreadable(context.getString(R.string.set_wg_unreadable))
            bytes.size > TUNNEL_FILE_MAX_BYTES -> PickedFile.Unreadable(context.getString(R.string.set_wg_too_big))
            else -> PickedFile.Read(name, decodeTunnelFile(bytes))
        }
    } catch (_: IOException) {
        PickedFile.Unreadable(context.getString(R.string.set_wg_unreadable))
    } catch (_: SecurityException) {
        PickedFile.Unreadable(context.getString(R.string.set_wg_unreadable))
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
