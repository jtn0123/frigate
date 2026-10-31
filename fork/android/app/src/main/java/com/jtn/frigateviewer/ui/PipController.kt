package com.jtn.frigateviewer.ui

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.graphics.Rect
import android.os.Build
import android.util.Rational
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import kotlin.math.roundToInt

/**
 * Picture-in-picture for live video. A screen showing live video offers its
 * aspect ratio with [offer]; while one is on offer, leaving the app shrinks
 * it to a floating window instead of stopping it.
 */
class PipController(private val activity: Activity) {
    /** Whether the app is showing as the floating window, when screens show only their video. */
    var inPip by mutableStateOf(false)
        internal set

    val supported: Boolean = activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private var aspect: Float? = null

    /** Where the video is on screen, so the window grows out of it rather than the whole app. */
    private var bounds: Rect? = null

    /** Offers live video with this shape, or withdraws it with null. */
    fun offer(aspectRatio: Float?) {
        aspect = aspectRatio
        if (supported) activity.setPictureInPictureParams(params())
    }

    /** Tells where the offered video is drawn, in window pixels. */
    fun videoBounds(rect: Rect) {
        if (rect == bounds) return
        bounds = rect
        if (supported && aspect != null) activity.setPictureInPictureParams(params())
    }

    /** Shrinks to the floating window now, if video is on offer. */
    fun enter() {
        if (supported && aspect != null) activity.enterPictureInPictureMode(params())
    }

    /** Before Android 12 the app has to enter it itself when the user leaves. */
    fun onUserLeaveHint() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) enter()
    }

    private fun params(): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder()
        aspect?.let { builder.setAspectRatio(rational(it)) }
        bounds?.let { builder.setSourceRectHint(it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(aspect != null).setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }
}

/** Android refuses ratios outside 1:2.39 to 2.39:1, so very tall or wide cameras are clamped. */
internal fun rational(aspectRatio: Float): Rational {
    val clamped = aspectRatio.coerceIn(1 / MAX_PIP_RATIO, MAX_PIP_RATIO)
    return Rational((clamped * RATIO_SCALE).roundToInt(), RATIO_SCALE)
}

private const val MAX_PIP_RATIO = 2.39f
private const val RATIO_SCALE = 1000

/** The activity's picture-in-picture, or null where there is none (tests). */
val LocalPip = staticCompositionLocalOf<PipController?> { null }
