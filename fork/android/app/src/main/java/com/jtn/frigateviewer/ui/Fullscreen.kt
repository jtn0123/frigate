package com.jtn.frigateviewer.ui

import android.content.Context
import android.content.pm.ActivityInfo
import android.provider.Settings
import android.view.OrientationEventListener
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
 * Returns a toggle into and out of fullscreen. Each way turns the screen at once, then hands
 * rotation back to the sensor once the phone is held that way, so turning it back works again.
 * Leaving the screen always releases the lock.
 */
@Composable
fun rememberFullscreenToggle(): (Boolean) -> Unit {
    val activity = LocalActivity.current
    val window = LocalWindowInfo.current.containerDpSize
    val orientation = remember(activity) {
        lateinit var lock: FullscreenOrientation
        val sensor = activity?.let {
            object : OrientationEventListener(it) {
                override fun onOrientationChanged(degrees: Int) = lock.onSensor(degrees)
            }
        }
        lock = FullscreenOrientation(
            request = { activity?.requestedOrientation = it },
            watch = { on ->
                val watching = on && sensor?.canDetectOrientation() == true
                if (watching) sensor?.enable() else sensor?.disable()
                watching
            },
            autoRotate = { activity?.let(::autoRotateOn) ?: false },
        )
        lock
    }
    DisposableEffect(orientation) {
        onDispose {
            fullscreenRequested = false
            orientation.release()
        }
    }
    // Turned upright after the lock was handed back: fullscreen was left the natural way.
    val upright = window.width <= window.height
    LaunchedEffect(upright) {
        if (upright && !orientation.turningSideways) fullscreenRequested = false
    }
    return { fullscreen ->
        fullscreenRequested = fullscreen
        orientation.set(fullscreen)
    }
}

/**
 * Back leaves [fullscreen] before it leaves the screen. Only once: should the screen stay
 * sideways regardless, as a window too short for the controls with no sensor to turn it,
 * the next Back leaves rather than trapping the user.
 */
@Composable
fun FullscreenBackHandler(fullscreen: Boolean, setFullscreen: (Boolean) -> Unit) {
    var exited by remember { mutableStateOf(false) }
    LaunchedEffect(fullscreen) { if (!fullscreen) exited = false }
    BackHandler(enabled = fullscreen && !exited) {
        exited = true
        setFullscreen(false)
    }
}

/** Whether the user lets the screen turn with the phone, rather than locking it. */
private fun autoRotateOn(context: Context): Boolean =
    Settings.System.getInt(context.contentResolver, Settings.System.ACCELEROMETER_ROTATION, 0) == 1

/**
 * The orientation asked of the activity on the way into and out of fullscreen. Each way is
 * forced until the sensor reports the phone held that way, then released to the sensor:
 * without that, "Exit fullscreen" while held sideways would turn straight back. [watch]
 * starts or stops the sensor and says whether it can report; [autoRotate] says whether the
 * user lets the screen turn at all, as releasing a sideways lock with rotation locked would
 * turn the screen back upright under the user.
 */
internal class FullscreenOrientation(
    private val request: (Int) -> Unit,
    private val watch: (Boolean) -> Boolean,
    private val autoRotate: () -> Boolean,
) {
    private var awaiting: Hold? = null

    /** True while fullscreen waits for the phone to be turned sideways. */
    val turningSideways: Boolean get() = awaiting == Hold.SIDEWAYS

    fun set(fullscreen: Boolean) {
        if (fullscreen) {
            request(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
            // With rotation locked, sideways stays until fullscreen is left.
            awaiting = if (autoRotate() && watch(true)) Hold.SIDEWAYS else null
        } else {
            request(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT)
            if (watch(true)) awaiting = Hold.UPRIGHT else release()
        }
    }

    /** A reading from the sensor, in degrees, or [OrientationEventListener.ORIENTATION_UNKNOWN]. */
    fun onSensor(degrees: Int) {
        val held = holdOf(degrees) ?: return
        if (held == awaiting) release()
    }

    /** Hands rotation back to the sensor and the user's setting. */
    fun release() {
        awaiting = null
        watch(false)
        request(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
    }

    private enum class Hold { UPRIGHT, SIDEWAYS }

    private fun holdOf(degrees: Int): Hold? = when {
        degrees < 0 -> null
        // Within this of straight up or down; the angles between are ambiguous.
        degrees % 180 <= TILT || degrees % 180 >= 180 - TILT -> Hold.UPRIGHT
        degrees % 180 in 90 - TILT..90 + TILT -> Hold.SIDEWAYS
        else -> null
    }

    private companion object {
        const val TILT = 30
    }
}

/** Below this height sideways, the controls and the video do not both fit. */
private val COMPACT_HEIGHT = 480.dp
