package com.jtn.frigateviewer.ui

import androidx.lifecycle.SavedStateHandle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The back stack and tab, and how they survive Android stopping the app. */
class NavigatorTest {
    private val saved = SavedStateHandle()
    private val nav = Navigator(saved)

    @Test
    fun backClosesScreensInTheOrderTheyOpened() {
        nav.openCamera("driveway")
        nav.push(Overlay.Event("r1"))

        assertTrue(nav.back())
        assertEquals(listOf(Overlay.CameraDetail("driveway")), nav.overlays)
        assertTrue(nav.back())
        assertFalse("Only the tabs are left", nav.back())
    }

    @Test
    fun replaceSwapsTheTopScreenOfItsKindWithoutGrowingTheStack() {
        nav.openCamera("driveway")
        nav.push(Overlay.Event("r1"))

        nav.replace(Overlay.Event("r2"))

        assertEquals(listOf(Overlay.CameraDetail("driveway"), Overlay.Event("r2")), nav.overlays)
    }

    @Test
    fun replacePushesWhenNoScreenOfItsKindIsOpen() {
        nav.replace(Overlay.Event("r1"))

        assertEquals(listOf(Overlay.Event("r1")), nav.overlays)
    }

    @Test
    fun theTabAndStackAreRestoredFromSavedState() {
        nav.tab = Tab.REVIEW
        nav.openCamera("driveway")
        nav.openRecording("driveway", minutes = 15)

        val restored = Navigator(saved)

        assertEquals(Tab.REVIEW, restored.tab)
        assertEquals(nav.overlays.toList(), restored.overlays.toList())
    }

    @Test
    fun clearKeepsTheTab() {
        nav.tab = Tab.SETTINGS
        nav.openCamera("driveway")

        nav.clear()

        assertEquals(emptyList<Overlay>(), Navigator(saved).overlays)
        assertEquals(Tab.SETTINGS, nav.tab)
    }

    @Test
    fun anUnreadableSavedStackStartsEmpty() {
        val restored = Navigator(SavedStateHandle(mapOf("overlays" to "not json", "tab" to "GONE")))

        assertEquals(emptyList<Overlay>(), restored.overlays)
        assertEquals(Tab.CAMERAS, restored.tab)
    }
}
