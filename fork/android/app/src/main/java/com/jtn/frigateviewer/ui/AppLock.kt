package com.jtn.frigateviewer.ui

import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Whether the app must be unlocked before it shows anything, when the lock is
 * turned on. It starts locked, and locks again when the app comes back after
 * more than [graceMs] away, so a quick switch to another app does not ask again.
 * The time away is read from a [clock] that only moves forward: with the wall
 * clock, setting the phone's time back would make it negative and never relock.
 */
class AppLock(private val graceMs: Long = GRACE_MS, private val clock: () -> Long = SystemClock::elapsedRealtime) {
    var locked by mutableStateOf(true)
        private set

    private var leftAt: Long? = null

    fun unlocked() {
        locked = false
        // Typing the screen lock opens another screen; coming back from it is not leaving.
        leftAt = null
    }

    fun onBackground() {
        leftAt = clock()
    }

    fun onForeground() {
        val left = leftAt ?: return
        leftAt = null
        if (clock() - left > graceMs) locked = true
    }

    private companion object {
        const val GRACE_MS = 30_000L
    }
}
