package com.jtn.frigateviewer.tunnel

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Tries [addresses] in turn until [connect] succeeds, all within [budgetMs].
 * Each gets an equal share of the time left, so an address that never answers
 * (often an IPv6 one) does not use up the time the others need. Throws the
 * last failure when none connects.
 */
internal fun connectToAny(addresses: List<InetAddress>, budgetMs: Int, connect: (InetAddress, timeoutMs: Int) -> Unit) {
    val deadline = System.nanoTime() + budgetMs * NANOS_PER_MS
    var failure: IOException = UnknownHostException("No address found")
    for ((index, address) in addresses.withIndex()) {
        val leftMs = (deadline - System.nanoTime()) / NANOS_PER_MS
        if (leftMs <= 0) break
        try {
            connect(address, (leftMs / (addresses.size - index)).toInt().coerceAtLeast(1))
            return
        } catch (e: IOException) {
            failure = e
        }
    }
    throw failure
}

private const val NANOS_PER_MS = 1_000_000L

/** Whether the server answers without the tunnel, as it does on the home network. */
enum class Reach { DIRECT, NOT_DIRECT, NO_NETWORK }

/** A direct check's result, with what happened in words for the tunnel log. */
data class Probe(val reach: Reach, val detail: String)

/** Checks the way to the server that does not go through the tunnel. */
interface DirectRoute {
    suspend fun check(baseUrl: String): Probe

    /** Calls [onChange] as networks come and go until the result is closed. */
    fun watch(onChange: () -> Unit): AutoCloseable
}

/**
 * Connects to the server over the phone's own networks, never the app's
 * tunnel, so the answer is the same whether the tunnel is up or not. Only a
 * TCP connection is made: a server that accepts it is reachable.
 */
class AndroidDirectRoute(context: Context) : DirectRoute {
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)

    /** Networks that are not a VPN, and what each carries; requests include NOT_VPN unless removed. */
    private val networks = ConcurrentHashMap<Network, NetworkCapabilities>()
    private val tracking = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            networks[network] = capabilities
        }

        override fun onLost(network: Network) {
            networks.remove(network)
        }
    }

    init {
        connectivity.registerNetworkCallback(internet(), tracking)
    }

    override suspend fun check(baseUrl: String): Probe {
        val url = baseUrl.toHttpUrlOrNull() ?: return Probe(Reach.NOT_DIRECT, "the server address cannot be read")
        val network = best() ?: return Probe(Reach.NO_NETWORK, "no network other than the tunnel")
        val via = "over ${kind(networks[network])} to ${url.scheme} port ${url.port} at ${describeHost(url.host)}"
        val started = System.nanoTime()
        val failure = withTimeoutOrNull(PROBE_MS.toLong()) {
            runInterruptible(Dispatchers.IO) {
                try {
                    // Looked up on that network too, so a name only the home router knows resolves at home only.
                    val addresses = network.getAllByName(url.host).toList()
                    connectToAny(addresses, PROBE_MS) { address, timeoutMs ->
                        network.socketFactory.createSocket().use { it.connect(InetSocketAddress(address, url.port), timeoutMs) }
                    }
                    ""
                } catch (e: IOException) {
                    "${e::class.simpleName}: ${maskAddresses(e.message.orEmpty())}"
                }
            }
        } ?: "no answer in $PROBE_MS ms"
        val ms = (System.nanoTime() - started) / NANOS_PER_MS
        return if (failure.isEmpty()) {
            Probe(Reach.DIRECT, "answered $via in $ms ms")
        } else {
            Probe(Reach.NOT_DIRECT, "not reached $via ($failure)")
        }
    }

    private fun kind(caps: NetworkCapabilities?): String = when {
        caps == null -> "an unknown network"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile data"
        else -> "another network"
    }

    /** Wi-Fi or Ethernet, where the home network would be, before mobile data. */
    private fun best(): Network? = networks.entries
        .sortedByDescending { (_, caps) ->
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        }
        .firstOrNull()
        ?.key

    override fun watch(onChange: () -> Unit): AutoCloseable {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = onChange()

            override fun onLost(network: Network) = onChange()
        }
        connectivity.registerNetworkCallback(internet(), callback)
        return AutoCloseable { connectivity.unregisterNetworkCallback(callback) }
    }

    private fun internet() = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()

    private companion object {
        const val PROBE_MS = 2_500
    }
}
