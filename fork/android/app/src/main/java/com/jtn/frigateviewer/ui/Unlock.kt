package com.jtn.frigateviewer.ui

import android.app.Activity
import android.app.KeyguardManager
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.view.WindowManager
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.res.stringResource
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
