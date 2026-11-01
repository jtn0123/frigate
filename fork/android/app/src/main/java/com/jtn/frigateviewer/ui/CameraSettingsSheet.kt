package com.jtn.frigateviewer.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.Camera

/**
 * A camera's settings, kept off the video: which stream to watch and, for an
 * admin, the server's switches and the camera's motor.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CameraSettingsSheet(
    vm: AppViewModel,
    camera: Camera,
    streamNames: List<String>,
    streamIndex: Int,
    onStream: (Int) -> Unit,
    onDismiss: () -> Unit,
) {
    // Opens to its full height, so nothing in it starts below the screen's edge.
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Palette.Surface,
    ) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 16.dp)) {
            Text(
                stringResource(R.string.cam_settings_title, camera.label),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
            )
            if (streamNames.size > 1) {
                SectionLabel(stringResource(R.string.cam_video_quality), Modifier.padding(start = 20.dp, end = 16.dp, top = 14.dp))
                Text(
                    stringResource(R.string.cam_video_quality_detail),
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextSecondary,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                )
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
                    streamNames.forEachIndexed { index, name ->
                        SegmentedButton(
                            selected = index == streamIndex,
                            onClick = { onStream(index) },
                            shape = SegmentedButtonDefaults.itemShape(index, streamNames.size),
                        ) { Text(name) }
                    }
                }
            }
            if (vm.controls.isAdmin) CameraControls(vm, camera)
        }
    }
}
