package com.jtn.frigateviewer.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private fun colorScheme(c: ThemeColors) = darkColorScheme(
    primary = c.accent,
    onPrimary = c.onAccent,
    primaryContainer = c.accentSurface,
    onPrimaryContainer = c.accentText,
    secondary = c.textMuted,
    secondaryContainer = c.surfaceHigh,
    onSecondaryContainer = c.text,
    background = c.background,
    onBackground = c.text,
    surface = c.background,
    onSurface = c.text,
    surfaceVariant = c.surface,
    onSurfaceVariant = c.textMuted,
    surfaceContainer = c.surface,
    surfaceContainerLow = c.surface,
    surfaceContainerHigh = c.surfaceHigh,
    surfaceContainerHighest = c.surfaceHigh,
    outline = c.outline,
    outlineVariant = c.outline,
    error = c.alert,
)

/** Monospaced text for certificate fingerprints, where every character must line up. */
val Mono = FontFamily.Monospace

/** Even-width digits in the regular face: times and counts line up without a typewriter look. */
val Tabular = TextStyle(fontFeatureSettings = "tnum")

private val base = Typography()
private val typography = base.copy(
    headlineMedium = base.headlineMedium.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp),
    titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold),
    titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
    titleSmall = base.titleSmall.copy(fontWeight = FontWeight.SemiBold),
    labelSmall = base.labelSmall.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp),
)

val MonoSmall = TextStyle(fontFamily = Mono, fontSize = 12.sp, fontWeight = FontWeight.Medium)

/** Durations and clocks over video and at the end of list rows. */
val DigitsSmall = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, fontFeatureSettings = "tnum")

/** Material's default "off" switch nearly vanishes on this background. */
@Composable
fun switchColors() = SwitchDefaults.colors(
    uncheckedThumbColor = Palette.TextSecondary,
    uncheckedTrackColor = Palette.SurfaceHigh,
    uncheckedBorderColor = Palette.TextSecondary,
)

@Composable
fun FrigateTheme(theme: AppTheme = AppTheme.Default, content: @Composable () -> Unit) {
    val scheme = remember(theme) { colorScheme(theme.colors) }
    CompositionLocalProvider(LocalThemeColors provides theme.colors) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
