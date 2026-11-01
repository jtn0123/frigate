package com.jtn.frigateviewer.ui

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.Ptz
import com.jtn.frigateviewer.data.PtzInfo
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ptzInfo
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A camera switch an admin can flip here; turning off one marked [confirmOff] is asked first. */
private class CameraSwitch(val key: String, @param:StringRes val title: Int, @param:StringRes val description: Int, val confirmOff: Boolean)

private val switches = listOf(
    CameraSwitch("detect", R.string.cam_switch_detect, R.string.cam_switch_detect_detail, confirmOff = true),
    CameraSwitch("recordings", R.string.cam_switch_recordings, R.string.cam_switch_recordings_detail, confirmOff = true),
    CameraSwitch("snapshots", R.string.cam_switch_snapshots, R.string.cam_switch_snapshots_detail, confirmOff = false),
)

/** The admin's controls for [camera]: its switches as the server reports them, and its motor when it has one. */
@Composable
fun CameraControls(vm: AppViewModel, camera: Camera) {
    val control = vm.controls
    val state = vm.feed.activity[camera.name]?.switches.orEmpty()
    var confirming by remember { mutableStateOf<CameraSwitch?>(null) }
    val api = vm.session?.api
    LaunchedEffect(api, camera.name, camera.onvif) {
        if (camera.onvif && api != null) vm.ptz.load(api, camera.name)
    }
    LaunchedEffect(control.notice) {
        if (control.notice != null) {
            delay(NOTICE_MS)
            control.noticeShown()
        }
    }

    Column(Modifier.fillMaxWidth()) {
        SectionLabel(stringResource(R.string.cam_controls), Modifier.padding(start = 20.dp, end = 16.dp, top = 14.dp))
        val shown = switches.filter { it.key in state }
        if (control.commands == null || shown.isEmpty()) {
            Text(
                stringResource(R.string.cam_connecting_server),
                style = MaterialTheme.typography.bodySmall,
                color = Palette.TextSecondary,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }
        shown.forEach { switch ->
            val on = state[switch.key] == true
            Toggle(
                stringResource(switch.title),
                stringResource(switch.description),
                checked = on,
                enabled = control.commands != null,
                padding = PaddingValues(horizontal = 20.dp, vertical = 10.dp),
                onChange = { turnOn ->
                    if (!turnOn && switch.confirmOff) confirming = switch else control.setSwitch(camera.name, switch.key, turnOn)
                },
            )
        }
        if (camera.onvif) {
            when (val ptz = vm.ptz[camera.name]) {
                is Remote.Ready -> ptz.value.takeIf { it.any }?.let { PtzPad(it) { command -> control.ptz(camera.name, command) } }
                is Remote.Failed -> RetryLine(stringResource(R.string.cam_ptz_unavailable), Modifier.padding(start = 20.dp, end = 8.dp)) {
                    api?.let { vm.ptz.retry(it, camera.name) }
                }
                Remote.Loading -> Unit
            }
        }
        control.notice?.let {
            Text(
                it.resolve(),
                style = MaterialTheme.typography.bodySmall,
                color = Palette.Alert,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
            )
        }
    }

    confirming?.let { switch ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(stringResource(R.string.cam_turn_off_title, stringResource(switch.title).lowercase(), camera.label)) },
            text = { Text(stringResource(R.string.cam_turn_off_detail)) },
            confirmButton = {
                TextButton(onClick = {
                    confirming = null
                    control.setSwitch(camera.name, switch.key, false)
                }) { Text(stringResource(R.string.cam_turn_off)) }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/** Arrows that move while held, zoom, and the camera's presets. */
@Composable
private fun PtzPad(info: PtzInfo, send: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceEvenly,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (info.canMove) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                HoldButton(Icons.Outlined.KeyboardArrowUp, stringResource(R.string.cam_tilt_up), Ptz.UP, send)
                Row {
                    HoldButton(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, stringResource(R.string.cam_pan_left), Ptz.LEFT, send)
                    Spacer(Modifier.size(BUTTON_SIZE))
                    HoldButton(Icons.AutoMirrored.Outlined.KeyboardArrowRight, stringResource(R.string.cam_pan_right), Ptz.RIGHT, send)
                }
                HoldButton(Icons.Outlined.KeyboardArrowDown, stringResource(R.string.cam_tilt_down), Ptz.DOWN, send)
            }
        }
        if (info.canZoom) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                HoldButton(Icons.Outlined.Add, stringResource(R.string.cam_zoom_in), Ptz.ZOOM_IN, send)
                HoldButton(Icons.Outlined.Remove, stringResource(R.string.cam_zoom_out), Ptz.ZOOM_OUT, send)
            }
        }
    }
    if (info.presets.isNotEmpty()) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            info.presets.forEach { preset ->
                AssistChip(onClick = { send(Ptz.preset(preset)) }, label = { Text(preset) })
            }
        }
    }
}

/**
 * Sends [command] when pressed and STOP when let go. A screen reader's
 * double tap moves it a little, since it cannot hold.
 */
@Composable
private fun HoldButton(icon: ImageVector, label: String, command: String, send: (String) -> Unit) {
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    Box(
        Modifier
            .padding(4.dp)
            .size(BUTTON_SIZE)
            .clip(CircleShape)
            .background(Palette.SurfaceHigh)
            .pointerInput(command) {
                detectTapGestures(onPress = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    send(command)
                    // Also when the press is cut short, such as by the sheet closing under the
                    // finger, or the camera would keep moving. Sending does not suspend.
                    try {
                        tryAwaitRelease()
                    } finally {
                        send(Ptz.STOP)
                    }
                })
            }
            .semantics {
                role = Role.Button
                contentDescription = label
                onClick(label) {
                    scope.launch {
                        send(command)
                        try {
                            delay(NUDGE_MS)
                        } finally {
                            send(Ptz.STOP)
                        }
                    }
                    true
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null)
    }
}

private val BUTTON_SIZE = 52.dp
private const val NUDGE_MS = 400L
private const val NOTICE_MS = 4_000L
