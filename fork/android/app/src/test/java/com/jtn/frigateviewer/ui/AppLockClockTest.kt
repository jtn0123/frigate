package com.jtn.frigateviewer.ui

import java.time.Duration
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowSystemClock

/** The lock's own clock: the time since the phone started, which setting the date does not move. */
@RunWith(RobolectricTestRunner::class)
class AppLockClockTest {
    @Test
    fun theGracePeriodIsTimedByTheClockSinceBoot() {
        val lock = AppLock()
        lock.unlocked()
        lock.onBackground()

        ShadowSystemClock.advanceBy(Duration.ofMinutes(1))
        lock.onForeground()

        assertTrue(lock.locked)
    }
}
