package com.jtn.frigateviewer.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The key of a live grid with one of its cameras opened over it. The grid stays composed
 * beneath for [GRID_KEPT_MS], so a quick look at a camera and Back finds its streams still
 * open rather than connecting four again; once that has passed, or the app leaves the
 * screen, or anything else is opened, it is let go (null) and its players released.
 */
@Composable
internal fun rememberKeptGrid(overlays: List<Overlay>, keys: List<String>): String? {
    val beneath = overlays.lastIndex - 1
    val covered = keys.getOrNull(beneath)?.takeIf { overlays[beneath] is Overlay.LiveGrid && overlays.last() is Overlay.CameraDetail }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var released by remember(covered) { mutableStateOf(false) }
    LaunchedEffect(covered, lifecycle) {
        if (covered == null) return@LaunchedEffect
        // The time runs out, or the app goes to the background or behind its lock, whichever is first.
        withTimeoutOrNull(GRID_KEPT_MS) { lifecycle.currentStateFlow.first { !it.isAtLeast(Lifecycle.State.STARTED) } }
        released = true
    }
    return covered.takeUnless { released }
}

/**
 * A screen, or one [covered] by the screen above: still composed, so it keeps what it holds,
 * but neither placed nor drawn, touched or read out.
 */
@Composable
internal fun Layer(covered: Boolean, content: @Composable () -> Unit) {
    val hidden = if (covered) {
        Modifier.clearAndSetSemantics {}.layout { _, constraints -> layout(constraints.minWidth, constraints.minHeight) {} }
    } else {
        Modifier
    }
    Box(Modifier.fillMaxSize().then(hidden)) { content() }
}

/** How long a live grid keeps its streams open beneath a camera opened from it. */
internal const val GRID_KEPT_MS = 30_000L
