package com.jtn.frigateviewer.tunnel

import com.jtn.frigateviewer.data.TunnelSettings
import kotlinx.coroutines.launch

/**
 * Saves the tunnel in [text], from the file [name], turned on. Returns why
 * it cannot be used, or null once it is saved.
 */
suspend fun RemoteAccess.import(name: String, text: String): String? {
    try {
        appOnlyTunnel(text, packageName)
    } catch (e: TunnelConfigException) {
        log.add("Imported file \"$name\" not used: ${e.message}")
        return e.message
    }
    log.add("Imported file \"$name\": server is ${maskedEndpoints(text)}")
    store.saveTunnel(TunnelSettings(text, tunnelName(name), enabled = true))
    return null
}

/** The file's name without its `.conf`, however the file app cased it, as "Home.CONF". */
internal fun tunnelName(fileName: String): String = fileName.replace(CONF_SUFFIX, "")

private val CONF_SUFFIX = Regex("""\.conf$""", RegexOption.IGNORE_CASE)

fun RemoteAccess.setEnabled(enabled: Boolean) {
    val current = tunnel ?: return
    log.add(if (enabled) "Turned on in Settings" else "Turned off in Settings")
    // Turned on again by the user: a stop outside the app no longer holds it back.
    if (enabled) stoppedOutside = false
    scope.launch { store.saveTunnel(current.copy(enabled = enabled)) }
}

/**
 * Starts the tunnel when the user asks in Settings: after it was turned off
 * outside the app, or over another app's VPN that does not reach the server,
 * which Android then turns off.
 */
fun RemoteAccess.startTunnel() {
    if (status == TunnelStatus.OtherVpnInTheWay) {
        log.add("Chose the app's tunnel in Settings, which turns the other VPN off")
        overOtherVpn = true
    } else {
        log.add("Started in Settings")
    }
    stoppedOutside = false
    check()
}

fun RemoteAccess.remove() {
    log.add("Tunnel file removed")
    scope.launch { store.saveTunnel(null) }
}
