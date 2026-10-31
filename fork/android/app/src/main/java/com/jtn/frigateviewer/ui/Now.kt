package com.jtn.frigateviewer.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay

/** Where [ProvideTickingNow] reads the time, in epoch milliseconds; tests provide their own. */
internal val LocalClock = staticCompositionLocalOf<() -> Long> { System::currentTimeMillis }

/**
 * The time now, in epoch milliseconds, for relative times such as "4m ago". Under
 * [ProvideTickingNow] it moves on each minute, so those times stay true while they show.
 */
val LocalNow = compositionLocalOf { System.currentTimeMillis() }

/** Provides a [LocalNow] that moves on at each minute while the app is on screen, and at once on return. */
@Composable
fun ProvideTickingNow(content: @Composable () -> Unit) {
    val clock = LocalClock.current
    var now by remember { mutableLongStateOf(clock()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, clock) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                now = clock()
                delay(MINUTE_MS - now % MINUTE_MS)
            }
        }
    }
    CompositionLocalProvider(LocalNow provides now, content = content)
}

private const val MINUTE_MS = 60_000L
