package com.jtn.frigateviewer.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/*
 * Grey shapes where the first load's content will be, laid out like it, so
 * the screen does not jump when the content arrives.
 */

/** Camera tiles in [columns], shaped like the grid on the Cameras tab. */
@Composable
fun CameraGridSkeleton(columns: Int) {
    Skeleton {
        Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            repeat(if (columns == 1) 3 else 4) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(columns) {
                        Box(Modifier.weight(1f).aspectRatio(16f / 9f).clip(RoundedCornerShape(14.dp)).background(Palette.Surface))
                    }
                }
            }
        }
    }
}

/** Review rows: a thumbnail and two lines of text, as [ReviewRow] lays them out. */
@Composable
fun ReviewListSkeleton() {
    Skeleton {
        Column(Modifier.padding(top = 8.dp)) {
            repeat(6) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).height(68.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(width = 121.dp, height = 68.dp).clip(RoundedCornerShape(12.dp)).background(Palette.Surface))
                    Column(Modifier.weight(1f).padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Bar(width = 0.6f, height = 14.dp)
                        Bar(width = 0.4f, height = 12.dp)
                    }
                }
            }
        }
    }
}

@Composable
private fun Bar(width: Float, height: Dp) {
    Box(Modifier.fillMaxWidth(width).height(height).clip(RoundedCornerShape(4.dp)).background(Palette.Surface))
}

/** Fades the shapes gently in and out, and reads as one "Loading" to a screen reader. */
@Composable
private fun Skeleton(content: @Composable () -> Unit) {
    val pulse by rememberInfiniteTransition(label = "skeleton").animateFloat(
        initialValue = 1f,
        targetValue = 0.5f,
        animationSpec = infiniteRepeatable(tween(800), RepeatMode.Reverse),
        label = "pulse",
    )
    // Laid out at full height and cut off at the bottom, never squeezed into a short screen.
    Box(Modifier.fillMaxSize().clipToBounds().alpha(pulse).clearAndSetSemantics { contentDescription = "Loading" }) {
        Box(Modifier.wrapContentHeight(Alignment.Top, unbounded = true)) { content() }
    }
}
