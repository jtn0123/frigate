package com.jtn.frigateviewer.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color

/** The current theme's colors (see [AppTheme]). Video stays the brightest thing on screen. */
object Palette {
    val Background: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.background
    val Surface: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.surface
    val SurfaceHigh: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.surfaceHigh
    val Chrome: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.chrome
    val Outline: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.outline
    val TextPrimary: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.text
    val TextSecondary: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.textMuted
    val Accent: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.accent
    val AccentText: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.accentText
    val Alert: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.alert
    val Detection: Color
        @Composable @ReadOnlyComposable
        get() = LocalThemeColors.current.detection

    /** The live dot is the same red in every theme, as on a camera. */
    val Live = Color(0xFFFB414A)
    val Ok = Color(0xFF34D399)
}
