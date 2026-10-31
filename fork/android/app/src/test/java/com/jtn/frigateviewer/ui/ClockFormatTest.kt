package com.jtn.frigateviewer.ui

import android.provider.Settings
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Times follow the phone's 12/24-hour setting, and timeline ticks say which half of the day. */
@RunWith(RobolectricTestRunner::class)
class ClockFormatTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val initial = use24HourClock

    @After
    fun tearDown() {
        use24HourClock = initial
        scope.cancel()
    }

    /** Today at [hour]:[minute], in epoch seconds. */
    private fun today(hour: Int, minute: Int) = LocalDate.now().atTime(hour, minute).atZone(ZoneId.systemDefault()).toEpochSecond()

    private fun showWithSetting(value: String) {
        val resolver = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver
        Settings.System.putString(resolver, Settings.System.TIME_12_24, value)
        compose.showApp(serverRule.server, temp.root, scope)
    }

    @Test
    fun aPhoneOnA24HourClockGets24HourTimes() {
        use24HourClock = false
        showWithSetting("24")

        assertTrue(compose.runOnIdle { use24HourClock })
        assertEquals("13:05", formatTime(today(13, 5).toDouble()))
        assertEquals("13:05:00", formatClock(today(13, 5).toDouble()))
        assertEquals("13:00", formatTick(today(13, 0)))
    }

    @Test
    fun aPhoneOnA12HourClockGetsAmAndPm() {
        use24HourClock = true
        showWithSetting("12")

        assertFalse(compose.runOnIdle { use24HourClock })
        assertEquals("1:05 PM", formatTime(today(13, 5).toDouble()))
        assertEquals("1:05:00 PM", formatClock(today(13, 5).toDouble()))
        // Ticks name the half of the day on the hour, and stay short between.
        assertEquals("1 PM", formatTick(today(13, 0)))
        assertEquals("1:15", formatTick(today(13, 15)))
    }
}
