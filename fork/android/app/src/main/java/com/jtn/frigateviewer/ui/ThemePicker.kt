package com.jtn.frigateviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

/** T3 Code's themes as small previews, three to a row; the chosen one is ringed and ticked. */
@Composable
fun ThemePicker(selected: AppTheme, onSelect: (AppTheme) -> Unit, modifier: Modifier = Modifier) {
    val haptics = LocalHapticFeedback.current
    Column(
        modifier.selectableGroup().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AppTheme.entries.chunked(COLUMNS).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { theme ->
                    ThemeSwatch(theme, theme == selected, Modifier.weight(1f)) {
                        if (theme != selected) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                        onSelect(theme)
                    }
                }
                repeat(COLUMNS - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** A miniature of the theme: its header band, a card with a line of text, and its accent. */
@Composable
private fun ThemeSwatch(theme: AppTheme, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = theme.colors
    Column(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(SWATCH_RATIO)
                .clip(RoundedCornerShape(16.dp))
                .background(c.chrome)
                .border(
                    if (selected) 2.dp else 1.dp,
                    if (selected) Palette.AccentText else Palette.Outline,
                    RoundedCornerShape(16.dp),
                ),
        ) {
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(top = 14.dp)
                    .clip(RoundedCornerShape(topStart = 10.dp, topEnd = 10.dp))
                    .background(c.background)
                    .padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(c.surface).padding(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(c.alert))
                    Box(Modifier.height(4.dp).width(22.dp).clip(CircleShape).background(c.text))
                }
                Box(Modifier.height(10.dp).fillMaxWidth(0.55f).clip(CircleShape).background(c.accent))
            }
            if (selected) {
                Icon(
                    Icons.Filled.CheckCircle,
                    contentDescription = null,
                    tint = Palette.AccentText,
                    modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).size(18.dp),
                )
            }
        }
        Text(
            theme.label,
            style = MaterialTheme.typography.labelLarge,
            color = if (selected) Palette.TextPrimary else Palette.TextSecondary,
        )
    }
}

private const val COLUMNS = 3
private const val SWATCH_RATIO = 1.1f
