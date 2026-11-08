package com.jtn.frigateviewer

import android.os.Looper
import java.time.Duration
import org.robolectric.Shadows.shadowOf

// How the tests wait for work on real threads: OkHttp and MockWebServer,
// Dispatchers.IO, an ExoPlayer's playback thread. A wait checks its condition
// every few milliseconds and fails once its time is up; none sleeps for a fixed
// time. Work on a test dispatcher moves on virtual time instead (advanceUntil in
// tunnel/TunnelFakes.kt).

/** How long a wait gives its condition unless it says otherwise. */
const val WAIT_MS = 5_000L

/** How often a wait checks again. */
private const val POLL_MS = 10L

/**
 * Waits in real time until [condition] holds, running [between] after each
 * check that fails, and fails once [timeoutMs] have passed.
 */
fun waitUntil(what: String = "the condition", timeoutMs: Long = WAIT_MS, between: () -> Unit = {}, condition: () -> Boolean) {
    val deadline = System.nanoTime() + Duration.ofMillis(timeoutMs).toNanos()
    while (!condition()) {
        if (System.nanoTime() - deadline > 0) throw AssertionError("Timed out after $timeoutMs ms waiting for $what")
        Thread.sleep(POLL_MS)
        between()
    }
}

/**
 * Runs what is due on Robolectric's main looper, after moving its clock on
 * [ms], so a `delay` on the main thread can finish; with 0 its time stands still.
 */
fun runMainLooper(ms: Long = 0) {
    val looper = shadowOf(Looper.getMainLooper())
    if (ms > 0) looper.idleFor(Duration.ofMillis(ms)) else looper.idle()
}

/**
 * [waitUntil], running the main looper between checks: work resumes there
 * after each request, and the test thread is the main thread, so nothing else
 * runs it. Its clock moves on [stepMs] each time; with 0 it stands still.
 */
fun waitOnMain(what: String = "the condition", timeoutMs: Long = WAIT_MS, stepMs: Long = POLL_MS, condition: () -> Boolean) =
    waitUntil(what, timeoutMs, between = { runMainLooper(stepMs) }, condition = condition)
