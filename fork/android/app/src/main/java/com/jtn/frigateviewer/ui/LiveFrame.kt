package com.jtn.frigateviewer.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.FrigateApi

/**
 * A camera's current view, refreshed from `latest.jpg` every [intervalMs]
 * while the screen is visible and [active]. The previous frame stays up until
 * the next one decodes, so there is no flicker between refreshes, and stays
 * up while inactive. Once the picture is more than twice [intervalMs] out of
 * date it is marked offline with its age, so a frozen picture does not pass
 * for a live one.
 */
@Composable
fun LiveFrame(
    api: FrigateApi,
    camera: String,
    intervalMs: Long,
    height: Int,
    modifier: Modifier = Modifier,
    active: Boolean = true,
    contentScale: ContentScale = ContentScale.Fit,
) {
    val snapshots = LocalSnapshots.current ?: remember { Snapshots() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(snapshots, api, camera, intervalMs, height, active) {
        if (!active) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            snapshots.follow(camera, intervalMs) { api.latestFrame(camera, height) }
        }
    }

    val snapshot = snapshots[camera]
    Box(modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        val current = snapshot.frame
        when {
            current != null -> Image(
                bitmap = current,
                contentDescription = null,
                contentScale = contentScale,
                modifier = Modifier.matchParentSize(),
            )
            snapshot.failed -> Icon(
                Icons.Default.VideocamOff,
                contentDescription = stringResource(R.string.cam_unavailable),
                tint = MaterialTheme.colorScheme.secondary,
            )
            else -> CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
        }
        // Only while the picture is meant to be refreshing: under live video it is not.
        snapshot.staleMs?.takeIf { active }?.let { stale ->
            OverlayTag(offlineLabel(stale).resolve(), Modifier.align(Alignment.Center), color = Palette.Alert)
        }
    }
}
