package com.jtn.frigateviewer.tunnel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Clearing the log and putting it back, for the Tunnel log's Undo. */
class TunnelLogUndoTest {
    private var now = 0L
    private val log = TunnelLog(capacity = 3, clock = { now++ }, repeatMs = 0)

    private fun texts() = log.entries.map { it.text }

    @Test
    fun aClearedLogComesBackBeforeWhatWasLoggedSince() {
        log.add("one")
        log.add("two")

        val cleared = log.clear()
        assertTrue(log.entries.isEmpty())
        log.add("three")
        log.restore(cleared)

        assertEquals(listOf("one", "two", "three"), texts())
    }

    @Test
    fun puttingItBackKeepsOnlyTheNewest() {
        log.add("one")
        log.add("two")
        val cleared = log.clear()
        log.add("three")
        log.add("four")

        log.restore(cleared)

        assertEquals("The oldest go, as when the log fills", listOf("two", "three", "four"), texts())
    }

    @Test
    fun puttingBackNothingChangesNothing() {
        log.add("one")
        log.restore(emptyList())
        assertEquals(listOf("one"), texts())
    }
}
