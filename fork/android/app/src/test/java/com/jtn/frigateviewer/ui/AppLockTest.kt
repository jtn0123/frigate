package com.jtn.frigateviewer.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockTest {
    private var now = 0L
    private val lock = AppLock(graceMs = 30_000, clock = { now })

    private fun away(ms: Long) {
        lock.onBackground()
        now += ms
        lock.onForeground()
    }

    @Test
    fun itStartsLocked() {
        assertTrue(lock.locked)
    }

    @Test
    fun aQuickSwitchAwayDoesNotLockAgain() {
        lock.unlocked()

        away(29_000)

        assertFalse(lock.locked)
    }

    @Test
    fun comingBackAfterTheGraceLocksAgain() {
        lock.unlocked()

        away(31_000)

        assertTrue(lock.locked)
    }

    @Test
    fun unlockingWithTheScreenLockIsNotLeaving() {
        // Typing the PIN stops the app; success arrives before it starts again.
        lock.onBackground()
        now += 60_000
        lock.unlocked()
        lock.onForeground()

        assertFalse(lock.locked)
    }
}
