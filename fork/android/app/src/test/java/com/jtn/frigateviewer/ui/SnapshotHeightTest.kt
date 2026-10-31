package com.jtn.frigateviewer.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SnapshotHeightTest {
    @Test
    fun roundsUpToTheNextSize() {
        assertEquals(180, snapshotHeight(1))
        assertEquals(270, snapshotHeight(181))
        assertEquals(540, snapshotHeight(540))
    }

    @Test
    fun capsAtTheLargestSize() {
        assertEquals(720, snapshotHeight(2_000))
    }
}
