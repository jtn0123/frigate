package com.jtn.frigateviewer.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveRetryTest {
    @Test
    fun aFailureReconnectsOnlyAfterTheDelay() {
        val retry = LiveRetry()
        retry.failed()
        assertEquals(LiveState.CONNECTING, retry.state)
        assertTrue(retry.pendingRetry)
        assertEquals(0, retry.attempt)

        retry.retry()
        assertFalse(retry.pendingRetry)
        assertEquals(1, retry.attempt)
        // A second call without a new failure starts nothing.
        retry.retry()
        assertEquals(1, retry.attempt)
    }

    @Test
    fun itGivesUpAfterTheRetriesRunOut() {
        val retry = LiveRetry(maxRetries = 2)
        repeat(2) {
            retry.failed()
            retry.retry()
        }
        retry.failed()
        assertEquals(LiveState.FAILED, retry.state)
        assertFalse(retry.pendingRetry)
        assertEquals(2, retry.attempt)
    }

    @Test
    fun playingAgainRestoresTheRetries() {
        val retry = LiveRetry(maxRetries = 1)
        retry.failed()
        retry.retry()
        retry.played()
        assertEquals(LiveState.PLAYING, retry.state)

        // A blip much later still gets its retry.
        retry.failed()
        assertEquals(LiveState.CONNECTING, retry.state)
    }

    @Test
    fun comingBackFromTheBackgroundStartsAfresh() {
        val retry = LiveRetry(maxRetries = 1)
        retry.failed()
        retry.retry()
        retry.failed()
        assertEquals(LiveState.FAILED, retry.state)

        retry.resumed()
        assertEquals(LiveState.CONNECTING, retry.state)
        assertEquals(1, retry.restarts)
        retry.failed()
        assertTrue(retry.pendingRetry)
    }
}
