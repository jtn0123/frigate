package com.jtn.frigateviewer.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.PlaylistAddCheck
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.BuildConfig
import com.jtn.frigateviewer.data.Session

@Composable
fun SettingsScreen(vm: AppViewModel, session: Session) {
    val settings = session.settings
    var showCertificate by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        ScreenHeader(title = "Settings", subtitle = null)
        TabSheet {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Group("Server") {
                    Info(Icons.Outlined.Link, "Address", settings.baseUrl.trimEnd('/'))
                    Info(Icons.Outlined.Person, "Signed in as", settings.username.ifEmpty { "No login (unauthenticated port)" })
                    Info(Icons.Outlined.Storage, "Frigate version", versionText(vm.serverVersion))
                    Info(
                        Icons.Outlined.MonitorHeart,
                        "Server health",
                        "Uptime, load, detectors and cameras",
                        onClick = { vm.nav.push(Overlay.Health) },
                    )
                    if (settings.certificatePin.isNotEmpty()) {
                        Info(
                            Icons.Outlined.Verified,
                            "Trusted certificate",
                            shortFingerprint(settings.certificatePin),
                            onClick = { showCertificate = true },
                        )
                    }
                }
                vm.remoteAccess?.let { remote ->
                    Group("Remote access") { RemoteAccessSettings(remote, onShowLog = { vm.nav.push(Overlay.TunnelLog) }) }
                }
                Group("Review") {
                    Toggle(
                        title = "Track what to review",
                        description = "Counts, badges and Mark reviewed. Turn off to just browse.",
                        checked = settings.trackReviews,
                        onChange = vm::setTrackReviews,
                        icon = Icons.AutoMirrored.Outlined.PlaylistAddCheck,
                    )
                    if (settings.trackReviews) {
                        Toggle(
                            title = "Mark reviewed when opened",
                            description = "Opening an alert or detection marks it reviewed on your server, like the web UI.",
                            checked = settings.markReviewedOnOpen,
                            onChange = vm::setMarkReviewedOnOpen,
                            icon = Icons.Outlined.DoneAll,
                        )
                    }
                }
                Group("Security") {
                    AppLockToggle(vm)
                }
                Group("Appearance") {
                    ThemePicker(selected = vm.theme, onSelect = vm::setTheme)
                }
                Group("About") {
                    Info(Icons.Outlined.Info, "App version", BuildConfig.VERSION_NAME)
                    Info(Icons.Outlined.Videocam, "Live video", "go2rtc over Frigate's MSE stream, with snapshots as a fallback")
                }
                Group(title = null) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.Button, onClick = vm::logout)
                            .heightIn(min = 56.dp)
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = null, tint = Palette.Alert)
                        Text(
                            if (settings.username.isEmpty()) "Change server" else "Sign out",
                            style = MaterialTheme.typography.bodyLarge,
                            color = Palette.Alert,
                        )
                    }
                }
            }
        }
    }

    if (showCertificate) {
        AlertDialog(
            onDismissRequest = { showCertificate = false },
            icon = { Icon(Icons.Outlined.Verified, contentDescription = null) },
            title = { Text("Trusted certificate") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("The server's certificate must match this SHA-256 fingerprint, or the app signs out.")
                    Text(settings.certificatePin, style = MonoSmall, color = Palette.TextPrimary)
                }
            },
            confirmButton = { TextButton(onClick = { showCertificate = false }) { Text("Done") } },
        )
    }
}

internal fun versionText(version: Remote<String>): String = when (version) {
    Remote.Loading -> "Checking…"
    is Remote.Ready -> version.value
    is Remote.Failed -> "Unknown: ${version.message}"
}

/** The first and last three bytes, enough to recognize a fingerprint at a glance. */
internal fun shortFingerprint(fingerprint: String): String {
    val bytes = fingerprint.split(':')
    if (bytes.size <= FINGERPRINT_ENDS * 2) return fingerprint
    return bytes.take(FINGERPRINT_ENDS).joinToString(":") + " … " + bytes.takeLast(FINGERPRINT_ENDS).joinToString(":")
}

/** An optional muted title over a card of rows; the rows need no dividers on its 28dp corners. */
@Composable
internal fun Group(title: String?, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (title != null) {
            Text(
                title,
                style = MaterialTheme.typography.titleSmall,
                color = Palette.TextSecondary,
                modifier = Modifier.padding(start = 16.dp),
            )
        }
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(Palette.Surface).padding(vertical = 4.dp),
        ) {
            content()
        }
    }
}

/** An icon, a label and its value below; with [onClick], a chevron says it opens something. */
@Composable
internal fun Info(icon: ImageVector, label: String, value: String, onClick: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClickLabel = "Show $label", onClick = onClick) else Modifier)
            .heightIn(min = 72.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(icon, contentDescription = null, tint = Palette.TextSecondary)
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(
                value,
                style = MaterialTheme.typography.bodyMedium,
                color = Palette.TextSecondary,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (onClick !=
            null
        ) {
            Icon(Icons.Outlined.ChevronRight, contentDescription = null, tint = Palette.TextSecondary.copy(alpha = CHEVRON_ALPHA))
        }
    }
}

private const val FINGERPRINT_ENDS = 3
private const val CHEVRON_ALPHA = 0.42f

/** Turning the lock on asks to unlock first, so it cannot be turned on in a way that locks the user out. */
@Composable
private fun AppLockToggle(vm: AppViewModel) {
    val activity = LocalActivity.current
    val available = activity?.canUnlock() == true
    Toggle(
        title = "Require unlock",
        description = if (available || vm.appLock) {
            "Ask for your fingerprint or screen lock when opening Frigate."
        } else {
            "Set a screen lock in Android's settings to use this."
        },
        checked = vm.appLock,
        onChange = { on ->
            if (!on) {
                vm.setAppLock(false)
            } else {
                activity?.authenticate { success, _ ->
                    if (success) {
                        vm.lock.unlocked()
                        vm.setAppLock(true)
                    }
                }
            }
        },
        icon = Icons.Outlined.Fingerprint,
        enabled = available || vm.appLock,
    )
}
