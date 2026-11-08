package com.jtn.frigateviewer.tunnel

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update

/**
 * Work that needs the tunnel after the app leaves, such as saving a clip:
 * [RemoteAccess] keeps it up while any hold is open.
 */
class TunnelHolds {
    private val open = MutableStateFlow(0)

    /** A hold, open until it is closed; closing it again does nothing. */
    fun hold(): AutoCloseable {
        open.update { it + 1 }
        val held = AtomicBoolean(true)
        return AutoCloseable { if (held.getAndSet(false)) open.update { it - 1 } }
    }

    /** Returns once no hold is open. */
    suspend fun released() {
        open.first { it == 0 }
    }
}
