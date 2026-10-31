package com.jtn.frigateviewer.tunnel

import android.content.Context
import android.net.VpnService
import com.wireguard.android.backend.BackendException
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Brings the app's own tunnel up and down. */
interface TunnelBackend {
    /** Android has allowed the app to open a VPN; it asks once, with [VpnService.prepare]. */
    fun hasPermission(): Boolean

    /** Starts the tunnel with [config], or replaces a running one's; throws [TunnelException] when it cannot. */
    suspend fun up(config: Config)

    suspend fun down()

    /** The running tunnel's traffic, and when its server last answered a handshake. */
    suspend fun stats(): TunnelStats

    /**
     * Calls [onStopped] when the tunnel goes down without [down] being asked,
     * as when the user disconnects the VPN in Android's settings or another
     * VPN app takes over. It may be called on any thread.
     */
    fun watchStops(onStopped: () -> Unit)
}

/** A WireGuard file that cannot be used, with a message saying why. */
class TunnelConfigException(message: String) : Exception(message)

/** The tunnel did not start, with a message for the user. */
class TunnelException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** WireGuard's userspace implementation, running in the app's VPN service. */
class WireGuardBackend(context: Context) : TunnelBackend {
    private val context = context.applicationContext
    private val backend by lazy { GoBackend(this.context) }

    /** Set while the app itself changes the tunnel, whose own DOWN is not news. */
    @Volatile private var changing = false

    @Volatile private var onStopped: () -> Unit = {}

    private val tunnel = object : Tunnel {
        override fun getName() = TUNNEL_NAME

        override fun onStateChange(newState: Tunnel.State) {
            if (newState == Tunnel.State.DOWN && !changing) onStopped()
        }
    }

    override fun watchStops(onStopped: () -> Unit) {
        this.onStopped = onStopped
    }

    override fun hasPermission() = VpnService.prepare(context) == null

    override suspend fun up(config: Config) {
        val failure = withContext(Dispatchers.IO) {
            try {
                changing = true
                backend.setState(tunnel, Tunnel.State.UP, config)
                null
            } catch (e: BackendException) {
                TunnelException(describe(e.reason), e)
            } catch (e: TimeoutException) {
                TunnelException("The VPN service did not start in time.", e)
            } catch (e: ExecutionException) {
                TunnelException("The VPN service did not start.", e)
            } catch (e: IllegalStateException) {
                // Android refuses to start a service while the app is in the background.
                TunnelException("The tunnel can only start while the app is open.", e)
            } finally {
                changing = false
            }
        }
        if (failure != null) throw failure
    }

    override suspend fun down() {
        withContext(Dispatchers.IO) {
            try {
                changing = true
                backend.setState(tunnel, Tunnel.State.DOWN, null)
            } catch (_: BackendException) {
                // Already down: nothing is running.
            } catch (_: TimeoutException) {
                // The service is not running, so neither is the tunnel.
            } catch (_: ExecutionException) {
                // As above.
            } catch (_: IllegalStateException) {
                // As above.
            } finally {
                changing = false
            }
        }
    }

    override suspend fun stats(): TunnelStats = withContext(Dispatchers.IO) {
        val stats = backend.getStatistics(tunnel)
        val handshake = stats.peers().maxOfOrNull { stats.peer(it)?.latestHandshakeEpochMillis() ?: 0L }?.takeIf { it > 0 }
        TunnelStats(sentBytes = stats.totalTx(), receivedBytes = stats.totalRx(), lastHandshakeMs = handshake)
    }

    private fun describe(reason: BackendException.Reason) = when (reason) {
        BackendException.Reason.VPN_NOT_AUTHORIZED -> "Android has not allowed the VPN connection."
        BackendException.Reason.DNS_RESOLUTION_FAILURE -> "Could not look up the VPN server's address."
        BackendException.Reason.UNABLE_TO_START_VPN, BackendException.Reason.TUN_CREATION_ERROR ->
            "Android did not start the VPN. Another VPN app may be on."
        else -> "The tunnel did not start."
    }

    private companion object {
        const val TUNNEL_NAME = "frigate"
    }
}
