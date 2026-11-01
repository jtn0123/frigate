package com.jtn.frigateviewer.tunnel

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Process
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
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

/**
 * What [e] says went wrong reaching [host], for the log: the host's name is
 * cut to its ending, as an address is to its kind, since a lookup failure
 * quotes the whole name.
 */
internal fun failureDetail(e: IOException, host: String): String {
    val message = e.message.orEmpty().let { if (host.isEmpty()) it else it.replace(host, maskHost(host), ignoreCase = true) }
    return "${e::class.simpleName}: ${maskAddresses(message)}"
}

/** Whether the server answers without the tunnel, as it does on the home network. */
enum class Reach { DIRECT, NOT_DIRECT, NO_NETWORK }

/**
 * A direct check's result, with what happened in words for the tunnel log.
 * [otherVpn]: the way tried was another app's VPN, such as UniFi Teleport,
 * Tailscale or the WireGuard app, which carries this app's connections while
 * it is on.
 */
data class Probe(val reach: Reach, val detail: String, val otherVpn: Boolean = false)

/** Checks the way to the server that does not go through the app's own tunnel. */
interface DirectRoute {
    /** [ownTunnelUp]: the app's tunnel runs, so a VPN that does not say whose it is, is taken to be it. */
    suspend fun check(baseUrl: String, ownTunnelUp: Boolean): Probe

    /**
     * Whether another app's VPN carries this app's connections now. It is
     * read from the network, never by asking Android for the VPN permission,
     * since asking hands the VPN to this app and turns the other one off.
     */
    fun otherVpnOn(ownTunnelUp: Boolean): Boolean

    /** Calls [onChange] as networks, VPNs included, come and go until the result is closed. */
    fun watch(onChange: () -> Unit): AutoCloseable
}

/** Whose VPN a network is, as far as Android says: it tells only the app that runs one. */
internal enum class Owner { THIS_APP, OTHER_APP, UNKNOWN }

/** What the direct check needs to know about a network. */
internal data class NetView(val kind: String, val vpn: Boolean, val owner: Owner, val validated: Boolean) {
    /** The app's own tunnel. One whose owner is not given is taken to be it while that runs, since Android runs one VPN. */
    fun ownTunnel(ownTunnelUp: Boolean) = vpn && (owner == Owner.THIS_APP || (owner == Owner.UNKNOWN && ownTunnelUp))
}

/** How the direct check tries the server. */
internal sealed interface ProbePlan<out N> {
    /** The way the app's connections go now, through another app's VPN. */
    data object OtherVpn : ProbePlan<Nothing>

    /** Over [network], the default one or, with the app's tunnel up, the one under it. */
    data class Over<N>(val network: N, val kind: String) : ProbePlan<N>

    data object NoNetwork : ProbePlan<Nothing>
}

/**
 * Where to try the server so the answer is the one the app's own connections
 * would get without its tunnel. They go over [default], Android's choice for
 * this app: another app's VPN while one is on, else Wi-Fi or mobile data. When
 * that is the app's own tunnel, the best of [networks] that is not a VPN
 * stands in, as Android would pick it: one that reaches the internet, Wi-Fi or
 * Ethernet before mobile data.
 */
internal fun <N> planProbe(default: Pair<N, NetView>?, networks: Map<N, NetView>, ownTunnelUp: Boolean): ProbePlan<N> {
    if (default != null && !default.second.ownTunnel(ownTunnelUp)) {
        val (network, view) = default
        return if (view.vpn) ProbePlan.OtherVpn else ProbePlan.Over(network, view.kind)
    }
    val best = networks.entries.filter { !it.value.vpn }.maxWithOrNull(
        compareBy<Map.Entry<N, NetView>> { it.value.validated }.thenBy { it.value.kind == WIFI || it.value.kind == ETHERNET },
    ) ?: return ProbePlan.NoNetwork
    return ProbePlan.Over(best.key, best.value.kind)
}

/**
 * The networks as far as a change matters to the direct check: which there
 * are, what each is and whether it reaches the internet. The app's own tunnel
 * is left out, so it coming up or down is not news, and so are the many
 * updates that change nothing here, such as signal strength.
 */
internal fun <N> networkState(networks: Map<N, NetView>): Set<Pair<N, NetView>> =
    networks.filterValues { !(it.vpn && it.owner == Owner.THIS_APP) }.map { it.key to it.value }.toSet()

/** The way a probe goes: how to look a name up and open a socket on it. */
internal class ProbeWay(
    val description: String,
    val otherVpn: Boolean,
    val lookup: (String) -> Array<InetAddress>,
    val socket: () -> Socket,
)

/**
 * Connects to [baseUrl]'s host and port over [way], within [budgetMs]. The
 * name is looked up that way too, so a name only the home router knows
 * resolves at home, or through a VPN to home.
 */
internal suspend fun probe(baseUrl: String, way: ProbeWay, budgetMs: Int = PROBE_MS): Probe {
    val url = baseUrl.toHttpUrlOrNull() ?: return Probe(Reach.NOT_DIRECT, "the server address cannot be read")
    val via = "${way.description} to ${url.scheme} port ${url.port} at ${describeHost(url.host)}"
    val started = System.nanoTime()
    val failure = withTimeoutOrNull(budgetMs.toLong()) {
        runInterruptible(Dispatchers.IO) {
            try {
                val addresses = way.lookup(url.host).toList()
                connectToAny(addresses, budgetMs) { address, timeoutMs ->
                    way.socket().use { it.connect(InetSocketAddress(address, url.port), timeoutMs) }
                }
                ""
            } catch (e: IOException) {
                failureDetail(e, url.host)
            }
        }
    } ?: "no answer in $budgetMs ms"
    val ms = (System.nanoTime() - started) / NANOS_PER_MS
    return if (failure.isEmpty()) {
        Probe(Reach.DIRECT, "answered $via in $ms ms", way.otherVpn)
    } else {
        Probe(Reach.NOT_DIRECT, "not reached $via ($failure)", way.otherVpn)
    }
}

internal const val PROBE_MS = 2_500
internal const val WIFI = "Wi-Fi"
internal const val ETHERNET = "Ethernet"

/**
 * Connects to the server the way the app's own connections go without its
 * tunnel, so the answer is the same whether the tunnel is up or not: through
 * another app's VPN while one is on, else over Wi-Fi or mobile data. Only a
 * TCP connection is made: a server that accepts it is reachable.
 */
class AndroidDirectRoute(context: Context) : DirectRoute {
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val myUid = Process.myUid()

    /** Every network, VPNs included, and what each carries. */
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
        connectivity.registerNetworkCallback(anyNetwork(), tracking)
    }

    override suspend fun check(baseUrl: String, ownTunnelUp: Boolean): Probe {
        val way = when (val plan = plan(ownTunnelUp)) {
            ProbePlan.NoNetwork -> return Probe(Reach.NO_NETWORK, "no network other than the tunnel")
            // Not bound to the VPN: a VPN that routes only some addresses leaves the rest to the
            // network under it, as it does for the app's own connections.
            ProbePlan.OtherVpn -> ProbeWay("through another VPN", true, InetAddress::getAllByName) { Socket() }
            is ProbePlan.Over -> ProbeWay("over ${plan.kind}", false, plan.network::getAllByName) {
                plan.network.socketFactory.createSocket()
            }
        }
        return probe(baseUrl, way)
    }

    override fun otherVpnOn(ownTunnelUp: Boolean): Boolean = plan(ownTunnelUp) == ProbePlan.OtherVpn

    private fun plan(ownTunnelUp: Boolean): ProbePlan<Network> {
        val default = connectivity.activeNetwork?.let { network ->
            connectivity.getNetworkCapabilities(network)?.let { network to view(it) }
        }
        return planProbe(default, networks.mapValues { view(it.value) }, ownTunnelUp)
    }

    private fun view(caps: NetworkCapabilities) = NetView(
        kind = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "a VPN"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> WIFI
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> ETHERNET
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile data"
            else -> "another network"
        },
        vpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
        owner = owner(caps),
        validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
    )

    /**
     * Whose VPN [caps] is. Android 11 and later tell the app that runs one;
     * Android 10 does not, so there the tunnel's own state tells (see [NetView.ownTunnel]).
     */
    private fun owner(caps: NetworkCapabilities): Owner = when {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.R -> Owner.UNKNOWN
        caps.ownerUid == myUid -> Owner.THIS_APP
        caps.ownerUid == Process.INVALID_UID -> Owner.UNKNOWN
        else -> Owner.OTHER_APP
    }

    override fun watch(onChange: () -> Unit): AutoCloseable {
        // Android first replays each network there is, which is not a change: only a
        // different state than when the watch began counts.
        val seen = ConcurrentHashMap(networks)
        var last = networkState(seen.mapValues { view(it.value) })
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                seen[network] = capabilities
                changed()
            }

            override fun onLost(network: Network) {
                seen.remove(network)
                changed()
            }

            private fun changed() {
                val now = networkState(seen.mapValues { view(it.value) })
                if (now != last) {
                    last = now
                    onChange()
                }
            }
        }
        connectivity.registerNetworkCallback(anyNetwork(), callback)
        return AutoCloseable { connectivity.unregisterNetworkCallback(callback) }
    }

    /** Every network, VPNs too: a request leaves VPNs out unless told otherwise. */
    private fun anyNetwork() = NetworkRequest.Builder().removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build()
}
