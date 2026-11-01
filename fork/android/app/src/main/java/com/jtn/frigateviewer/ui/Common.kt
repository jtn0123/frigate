package com.jtn.frigateviewer.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun <T> RemoteContent(
    state: Remote<T>,
    onRetry: () -> Unit,
    placeholder: (@Composable () -> Unit)? = null,
    content: @Composable (T) -> Unit,
) {
    when (state) {
        Remote.Loading -> placeholder?.invoke() ?: Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(strokeWidth = 2.dp)
        }
        is Remote.Failed -> EmptyState(
            Icons.Outlined.CloudOff,
            "Couldn't load this",
            detail = state.message,
            tint = Palette.Alert,
            action = EmptyAction("Retry", onRetry),
        )
        is Remote.Ready -> content(state.value)
    }
}

/** One line saying a part of a screen did not load, such as a timeline's motion, with a Retry button. */
@Composable
fun RetryLine(text: String, modifier: Modifier = Modifier, onRetry: () -> Unit) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.CloudOff, contentDescription = null, tint = Palette.Alert, modifier = Modifier.size(18.dp))
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = Palette.TextSecondary,
            modifier = Modifier.weight(1f).padding(start = 8.dp),
        )
        TextButton(onClick = onRetry) { Text("Retry") }
    }
}

/** A button offered by an [EmptyState], such as Retry. */
class EmptyAction(val label: String, val onClick: () -> Unit)

/**
 * What a screen shows instead of content: an icon in a tinted circle, a title, an
 * optional line of detail and an optional [action]. It fills and centers in the
 * space it has, and scrolls, so pull to refresh still works on an empty list.
 */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    detail: String? = null,
    tint: Color = Palette.TextSecondary,
    action: EmptyAction? = null,
) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        // Inside a list the height is unbounded: the list scrolls, and there is nothing to center in.
        val bounded = maxHeight != Dp.Infinity
        Column(
            Modifier
                .fillMaxWidth()
                .then(if (bounded) Modifier.verticalScroll(rememberScrollState()).heightIn(min = maxHeight) else Modifier)
                .padding(horizontal = 32.dp, vertical = 40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
        ) {
            Box(
                Modifier.size(64.dp).clip(CircleShape).background(tint.copy(alpha = EMPTY_TINT)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(28.dp))
            }
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp).semantics { heading() },
            )
            if (detail != null) {
                Text(detail, style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary, textAlign = TextAlign.Center)
            }
            if (action != null) {
                Button(
                    onClick = action.onClick,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    ),
                    modifier = Modifier.padding(top = 8.dp),
                ) { Text(action.label) }
            }
        }
    }
}

private const val EMPTY_TINT = 0.14f

/** Large left-aligned screen title with a status line and trailing actions. */
@Composable
fun ScreenHeader(title: String, subtitle: String?, actions: @Composable RowScope.() -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.headlineMedium)
            if (subtitle != null) {
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Palette.TextSecondary)
            }
        }
        actions()
    }
}

/** A tab's content on a sheet with rounded top corners, set into the header's band of color. */
@Composable
fun TabSheet(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
            .background(Palette.Background),
        content = content,
    )
}

/** Status tag over video: a breathing red dot while [live], a still grey one otherwise. */
@Composable
fun LivePill(label: String, live: Boolean, modifier: Modifier = Modifier) {
    val pulse by rememberInfiniteTransition(label = "live").animateFloat(
        initialValue = 1f,
        targetValue = 0.25f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "live-dot",
    )
    Row(
        modifier
            .clip(RoundedCornerShape(6.dp))
            .background(Color(0xB3000000))
            .padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(
            Modifier
                .size(7.dp)
                .alpha(if (live) pulse else 1f)
                .clip(CircleShape)
                .background(if (live) Palette.Live else Palette.TextSecondary),
        )
        Text(label, color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
    }
}

/** Small translucent chip for text over video. */
@Composable
fun OverlayTag(text: String, modifier: Modifier = Modifier, color: Color = Color.White) {
    Text(
        text,
        style = DigitsSmall,
        color = color,
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(Color(0xB3000000))
            .padding(horizontal = 7.dp, vertical = 3.dp),
    )
}

@Composable
fun CountBadge(count: Int, color: Color, modifier: Modifier = Modifier) {
    Text(
        if (count > 99) "99+" else count.toString(),
        color = Color.White,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        style = Tabular,
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(color)
            .padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

@Composable
fun SeverityDot(isAlert: Boolean, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(if (isAlert) Palette.Alert else Palette.Detection),
    )
}

/** Darkens the bottom of an image so white text stays readable. */
val BottomScrim = Brush.verticalGradient(0f to Color.Transparent, 1f to Color(0xD9000000))

/** A section's name in sentence case with a rule to the edge, like the review list's day headers. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().semantics { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = Palette.TextSecondary)
        HorizontalDivider(Modifier.weight(1f), color = Palette.Outline)
    }
}

/** A pushed screen's top bar on the header band: back, a title and its actions. */
@Composable
fun DetailHeader(title: String, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(start = 4.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
        }
        Text(
            title,
            style = MaterialTheme.typography.titleLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        actions()
    }
}
