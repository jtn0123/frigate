package com.jtn.frigateviewer.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ZoomStateTest {
    private val frame = Size(400f, 300f)

    @Test
    fun pinchingKeepsThePointUnderTheFingers() {
        val zoom = ZoomState()
        // Pinch to twice the size around a point 100 px right of center.
        zoom.transform(Offset(100f, 0f), Offset.Zero, 2f, frame)
        assertEquals(2f, zoom.scale)
        // That point was at 100; it stays at 100 * 2 + offset = 100.
        assertEquals(-100f, zoom.offset.x)
    }

    @Test
    fun itStaysBetweenWholeAndTheMostZoom() {
        val zoom = ZoomState(maxScale = 4f)
        zoom.transform(Offset.Zero, Offset.Zero, 0.5f, frame)
        assertEquals(1f, zoom.scale)
        zoom.transform(Offset.Zero, Offset.Zero, 10f, frame)
        assertEquals(4f, zoom.scale)
    }

    @Test
    fun anEdgeNeverComesInsideTheFrame() {
        val zoom = ZoomState()
        // Not zoomed: nothing to move.
        zoom.transform(Offset.Zero, Offset(50f, 50f), 1f, frame)
        assertEquals(Offset.Zero, zoom.offset)

        zoom.transform(Offset.Zero, Offset.Zero, 2f, frame)
        zoom.transform(Offset.Zero, Offset(1_000f, -1_000f), 1f, frame)
        // At 2x the picture overhangs by half the frame on each side.
        assertEquals(Offset(200f, -150f), zoom.offset)
    }

    @Test
    fun doubleTapZoomsInThenBackOut() {
        val zoom = ZoomState()
        zoom.toggle(Offset(40f, 20f), frame)
        assertTrue(zoom.zoomed)
        assertEquals(ZoomState.DOUBLE_TAP_SCALE, zoom.scale)

        zoom.toggle(Offset.Zero, frame)
        assertFalse(zoom.zoomed)
        assertEquals(Offset.Zero, zoom.offset)
    }
}
