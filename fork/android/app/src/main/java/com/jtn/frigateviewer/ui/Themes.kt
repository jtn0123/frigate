package com.jtn.frigateviewer.ui

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** One theme's colors, by the role each plays in the app. */
data class ThemeColors(
    /** Each tab's sheet, and full screens. */
    val background: Color,
    /** Cards and rows that sit on the sheet. */
    val surface: Color,
    /** Dialogs, toasts and chips raised above the cards. */
    val surfaceHigh: Color,
    /** The header band and bottom bar around each tab's sheet. */
    val chrome: Color,
    val outline: Color,
    val text: Color,
    val textMuted: Color,
    val accent: Color,
    val onAccent: Color,
    /** The accent's lighter shade, for text in the accent's color. */
    val accentText: Color,
    /** The accent's tint behind selected filters. */
    val accentSurface: Color,
    val alert: Color,
    val detection: Color,
)

/**
 * T3 Code's built-in themes, dark variants: its default and the five others,
 * converted from the OKLCH values in its `packages/shared/src/themePalettes.ts`.
 * Each maps canvas to the sheet, raised surface to cards, row hover to the
 * header band, and its update colors to selected filters.
 */
enum class AppTheme(val id: String, val label: String, val colors: ThemeColors) {
    T3_CODE(
        "t3-code",
        "T3 Code",
        ThemeColors(
            background = Color(0xFF0A0A0A),
            surface = Color(0xFF111111),
            surfaceHigh = Color(0xFF1A1A1A),
            chrome = Color(0xFF141414),
            // T3 Code's own #191919 hides control outlines on the header band.
            outline = Color(0xFF262626),
            text = Color(0xFFF5F5F5),
            textMuted = Color(0xFF818181),
            accent = Color(0xFF346BF1),
            onAccent = Color.White,
            accentText = Color(0xFF51A2FF),
            accentSurface = Color(0xFF121B34),
            alert = Color(0xFFFB414A),
            detection = Color(0xFFFE9A00),
        ),
    ),
    T3_CHAT(
        "t3-chat",
        "T3 Chat",
        ThemeColors(
            background = Color(0xFF1F1A24),
            surface = Color(0xFF2C2631),
            surfaceHigh = Color(0xFF332A38),
            chrome = Color(0xFF261922),
            outline = Color(0xFF3A3340),
            text = Color(0xFFF9F8FB),
            textMuted = Color(0xFFB9A6B3),
            accent = Color(0xFFA3004C),
            onAccent = Color(0xFFFBD0E8),
            accentText = Color(0xFFFBD0E8),
            accentSurface = Color(0xFF37152B),
            // T3 Chat's error is a deep rose; this lighter one reads as text on its dark plum.
            alert = Color(0xFFF0517F),
            detection = Color(0xFFF59E0B),
        ),
    ),
    GROVE(
        "grove",
        "Grove",
        ThemeColors(
            background = Color(0xFF1B2821),
            surface = Color(0xFF26332C),
            surfaceHigh = Color(0xFF36413C),
            chrome = Color(0xFF223A2D),
            outline = Color(0xFF415F4F),
            text = Color(0xFFFFFAFF),
            textMuted = Color(0xFF9AA19E),
            accent = Color(0xFF69D69A),
            onAccent = Color(0xFF241523),
            accentText = Color(0xFF9EE4BE),
            accentSurface = Color(0xFF345F48),
            alert = Color(0xFFFB414A),
            detection = Color(0xFFFE9A00),
        ),
    ),
    OCEAN(
        "ocean",
        "Ocean",
        ThemeColors(
            background = Color(0xFF17212B),
            surface = Color(0xFF222D38),
            surfaceHigh = Color(0xFF333B45),
            chrome = Color(0xFF1F3241),
            outline = Color(0xFF405567),
            text = Color(0xFFFFFAFF),
            textMuted = Color(0xFF979AA3),
            accent = Color(0xFF70B9EE),
            onAccent = Color(0xFF241523),
            accentText = Color(0xFFA2D2F4),
            accentSurface = Color(0xFF345269),
            alert = Color(0xFFFB414A),
            detection = Color(0xFFFE9A00),
        ),
    ),
    EMBER(
        "ember",
        "Ember",
        ThemeColors(
            background = Color(0xFF291E1A),
            surface = Color(0xFF352925),
            surfaceHigh = Color(0xFF433835),
            chrome = Color(0xFF3B2A22),
            outline = Color(0xFF664C3F),
            text = Color(0xFFFFFAFF),
            textMuted = Color(0xFFA0989A),
            accent = Color(0xFFF09A64),
            onAccent = Color(0xFF241523),
            accentText = Color(0xFFF5BD9A),
            accentSurface = Color(0xFF684631),
            alert = Color(0xFFFB414A),
            detection = Color(0xFFFE9A00),
        ),
    ),
    IRIS(
        "iris",
        "Iris",
        ThemeColors(
            background = Color(0xFF1D1929),
            surface = Color(0xFF292434),
            surfaceHigh = Color(0xFF383443),
            chrome = Color(0xFF2B243F),
            outline = Color(0xFF4D4366),
            text = Color(0xFFFFFAFF),
            textMuted = Color(0xFF98949F),
            accent = Color(0xFF9D7DF2),
            onAccent = Color(0xFF241523),
            accentText = Color(0xFFBFABF7),
            accentSurface = Color(0xFF463969),
            alert = Color(0xFFFB414A),
            detection = Color(0xFFFE9A00),
        ),
    ),
    ;

    companion object {
        val Default = T3_CODE

        /** The theme saved as [id], or the default for one this version does not know. */
        fun byId(id: String): AppTheme = entries.firstOrNull { it.id == id } ?: Default
    }
}

/** The theme's colors, read through [Palette]. */
val LocalThemeColors = staticCompositionLocalOf { AppTheme.Default.colors }
