package com.jtn.frigateviewer.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationTest {
    @Test
    fun theStackSurvivesSaving() {
        val stack = listOf(
            Overlay.CameraDetail("front_door"),
            Overlay.Event("1730000000.1-abc"),
            Overlay.Recording("front_door", 60, 1_730_000_000),
        )
        assertEquals(stack, decodeOverlays(encodeOverlays(stack)))
    }

    @Test
    fun nothingSavedOrUnreadableIsAnEmptyStack() {
        assertTrue(decodeOverlays(null).isEmpty())
        assertTrue(decodeOverlays("""[{"type":"gone"}]""").isEmpty())
        assertTrue(decodeOverlays("not json").isEmpty())
    }
}
