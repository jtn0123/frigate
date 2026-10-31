package com.jtn.frigateviewer.ui

import android.graphics.BitmapFactory
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.jtn.frigateviewer.data.FrigateApi
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * A camera's current view, refreshed from `latest.jpg` every [intervalMs]
 * while the screen is visible and [active]. The previous frame stays up until
 * the next one decodes, so there is no flicker between refreshes, and stays
 * up while inactive.
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
    var frame by remember(camera) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(camera) { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(api, camera, intervalMs, height, active) {
        if (!active) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                try {
                    val bytes = api.latestFrame(camera, height)
                    val bitmap = withContext(Dispatchers.Default) {
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                    }
                    if (bitmap != null) {
                        frame = bitmap
                        failed = false
                    }
                } catch (_: IOException) {
                    failed = frame == null
                }
                delay(intervalMs)
            }
        }
    }

    Box(modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        val current = frame
        when {
            current != null -> Image(
                bitmap = current,
                contentDescription = null,
                contentScale = contentScale,
                modifier = Modifier.matchParentSize(),
            )
            failed -> Icon(
                Icons.Default.VideocamOff,
                contentDescription = "Camera unavailable",
                tint = MaterialTheme.colorScheme.secondary,
            )
            else -> CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
        }
    }
}
