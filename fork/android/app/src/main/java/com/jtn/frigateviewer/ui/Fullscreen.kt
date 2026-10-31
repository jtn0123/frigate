package com.jtn.frigateviewer.ui

import android.content.pm.ActivityInfo
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** Set while a screen has asked for fullscreen, which on a tablet already held sideways turns nothing. */
private var fullscreenRequested by mutableStateOf(false)

/**
 * True when video goes fullscreen: a phone held sideways, too short for the controls
 * and details as well, or any device once fullscreen is asked for. A tablet held
 * sideways has room for both, so it keeps them.
 */
@Composable
fun isLandscape(): Boolean {
    val window = LocalWindowInfo.current.containerDpSize
    if (window.width <= window.height) return false
    return window.height < COMPACT_HEIGHT || fullscreenRequested
}

/** Hides the system bars while [enabled], restoring them when it ends or leaves composition. */
@Composable
fun ImmersiveEffect(enabled: Boolean) {
    val activity = LocalActivity.current ?: return
    DisposableEffect(enabled) {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        if (enabled) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose { controller.show(WindowInsetsCompat.Type.systemBars()) }
    }
}

/**
 * Returns a toggle that forces landscape (fullscreen) or hands orientation
 * back to the sensor. Leaving the screen always releases the lock.
 */
@Composable
fun rememberFullscreenToggle(): (Boolean) -> Unit {
    val activity = LocalActivity.current
    DisposableEffect(activity) {
        onDispose {
            fullscreenRequested = false
            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }
    return { fullscreen ->
        fullscreenRequested = fullscreen
        activity?.requestedOrientation = if (fullscreen) {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }
}

/** Below this height sideways, the controls and the video do not both fit. */
private val COMPACT_HEIGHT = 480.dp
