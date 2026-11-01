package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.Remote
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A value a screen shows and refreshes while it is open, such as the server's
 * health. It lives in the view model, so turning the phone keeps it, and its
 * requests run in [scope], the session's, so one left over from an ended
 * session cannot sign the next one out. A failed refresh keeps the last good
 * value rather than blanking the screen.
 */
class Polled<T>(
    private val scope: CoroutineScope,
    private val onSessionLost: (UiText?) -> Unit,
    private val load: suspend (FrigateApi) -> T,
) {
    var value by mutableStateOf<Remote<T>>(Remote.Loading)
        private set

    /** Fetches every [intervalMs] until the caller is cancelled, as when its screen closes or the app goes to the background. */
    suspend fun follow(api: FrigateApi, intervalMs: Long) {
        val job = scope.launch {
            while (true) {
                refresh(api)
                delay(intervalMs)
            }
        }
        try {
            job.join()
        } finally {
            job.cancel()
        }
    }

    /** Shows loading and fetches again at once, for a Retry button. */
    fun retry(api: FrigateApi): Job {
        value = Remote.Loading
        return scope.launch { refresh(api) }
    }

    /** Forgets the value, for a new session. */
    fun reset() {
        value = Remote.Loading
    }

    private suspend fun refresh(api: FrigateApi) {
        val next = loadRemote(onSessionLost) { load(api) }
        if (next is Remote.Ready || value !is Remote.Ready) value = next
    }
}

/**
 * Values fetched once per [K], such as a camera's motor controls or a day of
 * its motion, kept for the session so turning the phone or opening the screen
 * again does not ask again. A failure is kept too, so the screen can say so and
 * offer [retry]; asking for it again with [load] tries again. Only the last
 * [capacity] keys are kept.
 */
class RemoteCache<K, T>(
    private val scope: CoroutineScope,
    private val onSessionLost: (UiText?) -> Unit,
    private val capacity: Int = DEFAULT_CAPACITY,
    private val fetch: suspend (FrigateApi, K) -> T,
) {
    private val values = mutableStateMapOf<K, Remote<T>>()
    private val running = mutableMapOf<K, Job>()

    /** Oldest first, to drop the oldest once there are more than [capacity]. */
    private val order = ArrayDeque<K>()

    /** What is known for [key]: loading until [load] finishes. */
    operator fun get(key: K): Remote<T> = values[key] ?: Remote.Loading

    /** Fetches [key] unless it is already here or on its way; null then. A failed one is fetched again. */
    fun load(api: FrigateApi, key: K): Job? {
        if (values[key] is Remote.Ready || running[key]?.isActive == true) return null
        return start(api, key)
    }

    /** Shows loading for [key] and fetches it again, even when one is on its way. */
    fun retry(api: FrigateApi, key: K): Job {
        running[key]?.cancel()
        return start(api, key)
    }

    /** Forgets everything and stops what is on its way, for a new session. */
    fun reset() {
        running.values.forEach { it.cancel() }
        running.clear()
        values.clear()
        order.clear()
    }

    private fun start(api: FrigateApi, key: K): Job {
        values[key] = Remote.Loading
        order.remove(key)
        order.addLast(key)
        while (order.size > capacity) {
            val oldest = order.removeFirst()
            running.remove(oldest)?.cancel()
            values.remove(oldest)
        }
        // Started once registered, so a fetch that finishes at once still finds itself the owner.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            val result = loadRemote(onSessionLost) { fetch(api, key) }
            // A reset or a newer retry meanwhile owns the key now.
            if (running[key] === coroutineContext[Job]) {
                values[key] = result
                running.remove(key)
            }
        }
        running[key] = job
        job.start()
        return job
    }

    private companion object {
        const val DEFAULT_CAPACITY = 16
    }
}
