package com.jtn.frigateviewer.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

    /** WCAG's contrast ratio, from 1 (none) to 21 (black on white). */
    private fun contrast(a: Color, b: Color): Float {
        val (light, dark) = listOf(a.luminance(), b.luminance()).sortedDescending()
        return (light + 0.05f) / (dark + 0.05f)
    }

    @Test
    fun secondaryTextIsReadableInEveryTheme() {
        // Reviewed rows show their text in this grey rather than faded, which would fall below it.
        AppTheme.entries.forEach { theme ->
            val c = theme.colors
            assertTrue("${theme.id} on the sheet", contrast(c.textMuted, c.background) >= AA)
            assertTrue("${theme.id} on a card", contrast(c.textMuted, c.surface) >= AA)
        }
    }

    @Test
    fun statusTextOverVideoIsReadableEvenOnAWhiteFrame() {
        val pill = Color(0xB3000000).compositeOver(Color.White)
        assertTrue(contrast(Color.White, pill) >= AA)
    }

    private companion object {
        /** WCAG AA for text under 18pt. */
        const val AA = 4.5f
    }
}
