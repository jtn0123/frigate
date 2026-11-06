package com.jtn.frigateviewer.ui

import android.app.Activity
import android.app.KeyguardManager
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.view.WindowManager
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.jtn.frigateviewer.R

/** The phone has a screen lock, which unlocking needs: fingerprints and faces are only offered with one. */
fun Activity.canUnlock(): Boolean = getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true

/**
 * Asks for a fingerprint, face or the screen lock. [onResult] gets whether it
 * worked and, when it did not, the reason; cancelling has no reason.
 */
fun Activity.authenticate(onResult: (success: Boolean, reason: String?) -> Unit) {
    val builder = BiometricPrompt.Builder(this)
        .setTitle(getString(R.string.unlock_prompt_title))
        .setSubtitle(getString(R.string.unlock_prompt_subtitle))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        builder.setAllowedAuthenticators(Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL)
    } else {
        @Suppress("DEPRECATION")
        builder.setDeviceCredentialAllowed(true)
    }
    builder.build().authenticate(
        CancellationSignal(),
        mainExecutor,
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                onResult(true, null)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val cancelled = errorCode == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
                onResult(false, if (cancelled) null else errString.toString())
            }
        },
    )
}

/**
 * Keeps the app's content out of Recents while [hidden], as when the app lock
 * is on. Android 13 and later show a blank card; before that only
 * `FLAG_SECURE` hides it, which also blocks screenshots of the app.
 */
fun Activity.hideFromRecents(hidden: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        setRecentsScreenshotEnabled(!hidden)
    } else if (hidden) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    } else {
        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
}

/** Covers the app until it is unlocked, asking once on its own when it appears. */
@Composable
fun LockScreen(reason: String?, onUnlock: () -> Unit) {
    LaunchedEffect(Unit) { onUnlock() }
    EmptyState(
        Icons.Outlined.Lock,
        stringResource(R.string.lock_title),
        detail = reason ?: stringResource(R.string.lock_detail),
        tint = Palette.AccentText,
        action = EmptyAction(stringResource(R.string.lock_unlock), onUnlock),
    )
}

/**
 * Draws [lock] over [content] while [isLocked], keeping [content] composed so
 * every screen comes back as it was once unlocked. Meanwhile nothing of it is
 * drawn, touched, focused or read out, and it is told the app is stopped (its
 * lifecycle stays at created), so players, feeds and polling pause just as when
 * the app is in the background. [isLocked] is read again when the activity
 * starts, so a lock set in `onStart` holds before anything resumes.
 */
@Composable
fun LockGate(isLocked: () -> Boolean, lock: @Composable () -> Unit, content: @Composable (locked: Boolean) -> Unit) {
    val parent = LocalLifecycleOwner.current
    val gated = remember(parent) { GatedLifecycle(parent, isLocked) }
    DisposableEffect(gated) {
        parent.lifecycle.addObserver(gated)
        onDispose {
            parent.lifecycle.removeObserver(gated)
            gated.end()
        }
    }
    val locked = isLocked()
    SideEffect { gated.update() }
    // A focused field behind the lock would still take typing.
    val focus = LocalFocusManager.current
    LaunchedEffect(locked) { if (locked) focus.clearFocus(force = true) }
    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier
                .fillMaxSize()
                .drawWithContent { if (!locked) drawContent() }
                .then(if (locked) Modifier.clearAndSetSemantics {} else Modifier)
                .focusProperties { onEnter = { if (isLocked()) cancelFocusChange() } }
                .focusGroup(),
        ) {
            CompositionLocalProvider(LocalLifecycleOwner provides gated) { content(locked) }
        }
        // Opaque and full size; a Surface also takes every touch, so none reaches the screens beneath.
        if (locked) Surface(Modifier.fillMaxSize()) { lock() }
    }
}

/** [parent]'s lifecycle, held at created while [held]. */
private class GatedLifecycle(private val parent: LifecycleOwner, private val held: () -> Boolean) :
    LifecycleOwner,
    LifecycleEventObserver {
    private val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry

    override fun onStateChanged(source: LifecycleOwner, event: Lifecycle.Event) = update()

    fun update() {
        val state = parent.lifecycle.currentState
        val target = if (held() && state.isAtLeast(Lifecycle.State.STARTED)) Lifecycle.State.CREATED else state
        move(target)
    }

    /** Ends it for good, as when the gate leaves the screen. */
    fun end() = move(Lifecycle.State.DESTROYED)

    private fun move(target: Lifecycle.State) {
        val current = registry.currentState
        // A lifecycle never goes back to initialized, nor anywhere once destroyed.
        val allowed = current != Lifecycle.State.DESTROYED &&
            target != Lifecycle.State.INITIALIZED &&
            !(current == Lifecycle.State.INITIALIZED && target == Lifecycle.State.DESTROYED)
        if (allowed) registry.currentState = target
    }
}
