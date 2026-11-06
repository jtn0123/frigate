package com.jtn.frigateviewer.ui

import android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
import android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
import android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Fullscreen turns the screen at once, then hands rotation back once the phone is held that way. */
class FullscreenOrientationTest {
    /** Every orientation asked of the activity, in order. */
    private val requests = mutableListOf<Int>()
    private var watching = false

    private fun orientation(sensor: Boolean = true, autoRotate: Boolean = true) = FullscreenOrientation(
        request = requests::add,
        watch = { on -> (on && sensor).also { watching = it } },
        autoRotate = { autoRotate },
    )

    @Test
    fun exitingWhileHeldSidewaysStaysUprightUntilThePhoneIsTurned() {
        val orientation = orientation()
        orientation.set(false)
        assertEquals(listOf(SCREEN_ORIENTATION_SENSOR_PORTRAIT), requests)

        // Still sideways, or between: the screen must not turn straight back.
        listOf(90, 270, 45, -1).forEach(orientation::onSensor)
        assertEquals(listOf(SCREEN_ORIENTATION_SENSOR_PORTRAIT), requests)
        assertTrue(watching)

        orientation.onSensor(5)
        assertEquals(listOf(SCREEN_ORIENTATION_SENSOR_PORTRAIT, SCREEN_ORIENTATION_UNSPECIFIED), requests)
        assertFalse("The sensor stops once it is not needed", watching)

        orientation.onSensor(90)
        assertEquals("Turning sideways again is the user's to do", 2, requests.size)
    }

    @Test
    fun enteringWhileHeldUprightStaysSidewaysUntilThePhoneIsTurned() {
        val orientation = orientation()
        orientation.set(true)
        assertTrue(orientation.turningSideways)

        listOf(0, 350, 180).forEach(orientation::onSensor)
        assertEquals(listOf(SCREEN_ORIENTATION_SENSOR_LANDSCAPE), requests)

        orientation.onSensor(275)
        assertEquals(listOf(SCREEN_ORIENTATION_SENSOR_LANDSCAPE, SCREEN_ORIENTATION_UNSPECIFIED), requests)
        assertFalse(orientation.turningSideways)
    }

    @Test
    fun withRotationLockedFullscreenStaysSidewaysUntilLeft() {
        val orientation = orientation(autoRotate = false)
        orientation.set(true)
        orientation.onSensor(90)
        assertEquals(listOf(SCREEN_ORIENTATION_SENSOR_LANDSCAPE), requests)
        assertFalse(watching)

        orientation.set(false)
        orientation.onSensor(0)
        assertEquals(
            listOf(SCREEN_ORIENTATION_SENSOR_LANDSCAPE, SCREEN_ORIENTATION_SENSOR_PORTRAIT, SCREEN_ORIENTATION_UNSPECIFIED),
            requests,
        )
    }

    @Test
    fun withoutASensorExitingHandsRotationBackAtOnce() {
        val orientation = orientation(sensor = false)
        orientation.set(true)
        orientation.set(false)
        assertEquals(
            listOf(SCREEN_ORIENTATION_SENSOR_LANDSCAPE, SCREEN_ORIENTATION_SENSOR_PORTRAIT, SCREEN_ORIENTATION_UNSPECIFIED),
            requests,
        )
    }

    @Test
    fun leavingReleasesWhateverIsHeld() {
        val orientation = orientation()
        orientation.set(true)
        orientation.release()
        assertEquals(listOf(SCREEN_ORIENTATION_SENSOR_LANDSCAPE, SCREEN_ORIENTATION_UNSPECIFIED), requests)
        assertFalse(watching)
    }
}
