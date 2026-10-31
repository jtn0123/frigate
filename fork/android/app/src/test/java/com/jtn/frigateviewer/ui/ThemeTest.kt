package com.jtn.frigateviewer.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class ThemeTest {
    @Test
    fun aSavedThemeIsFoundByItsId() {
        assertEquals(AppTheme.OCEAN, AppTheme.byId("ocean"))
    }

    @Test
    fun anUnknownOrMissingThemeFallsBackToTheDefault() {
        assertEquals(AppTheme.T3_CODE, AppTheme.byId(""))
        assertEquals(AppTheme.T3_CODE, AppTheme.byId("from-a-newer-version"))
    }

    @Test
    fun everyThemeHasItsOwnId() {
        assertEquals(AppTheme.entries.size, AppTheme.entries.map { it.id }.toSet().size)
    }
}
