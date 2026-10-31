package com.jtn.frigateviewer.ui

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.toSize

/**
 * How far a picture is zoomed in and moved. Offsets are from the center, and
 * the picture never moves so far that an edge comes inside the frame.
 */
@Stable
class ZoomState(private val maxScale: Float = MAX_SCALE) {
    var scale by mutableFloatStateOf(1f)
        private set
    var offset by mutableStateOf(Offset.Zero)
        private set

    val zoomed: Boolean get() = scale > 1f

    /**
     * Applies a pinch of [zoom] around [centroid] and a drag of [pan], in a
     * frame of [size]; [centroid] is measured from the frame's center. The
     * point under the fingers stays under them.
     */
    fun transform(centroid: Offset, pan: Offset, zoom: Float, size: Size) {
        val newScale = (scale * zoom).coerceIn(1f, maxScale)
        val kept = centroid - (centroid - offset) * (newScale / scale)
        scale = newScale
        offset = clamp(kept + pan, size)
    }

    /** A double tap: zooms in on [at] (from the center), or back out when already in. */
    fun toggle(at: Offset, size: Size) {
        if (zoomed) {
            reset()
        } else {
            transform(at, Offset.Zero, DOUBLE_TAP_SCALE, size)
        }
    }

    fun reset() {
        scale = 1f
        offset = Offset.Zero
    }

    private fun clamp(value: Offset, size: Size): Offset {
        val maxX = (scale - 1f) * size.width / 2
        val maxY = (scale - 1f) * size.height / 2
        return Offset(value.x.coerceIn(-maxX, maxX), value.y.coerceIn(-maxY, maxY))
    }

    companion object {
        const val MAX_SCALE = 6f
        const val DOUBLE_TAP_SCALE = 2.5f
    }
}

/** Pinch to zoom, drag to move and double tap to zoom in or out, kept within the frame. */
fun Modifier.zoomable(state: ZoomState): Modifier = this
    .pointerInput(state) {
        detectTransformGestures { centroid, pan, zoom, _ ->
            val frame = size.toSize()
            state.transform(centroid - frame.center(), pan, zoom, frame)
        }
    }
    .pointerInput(state) {
        detectTapGestures(onDoubleTap = { at ->
            val frame = size.toSize()
            state.toggle(at - frame.center(), frame)
        })
    }
    .clipToBounds()
    .graphicsLayer {
        scaleX = state.scale
        scaleY = state.scale
        translationX = state.offset.x
        translationY = state.offset.y
    }

private fun Size.center() = Offset(width / 2, height / 2)
