package com.jtn.frigateviewer.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map

/** Connection details for one Frigate server. */
data class ServerSettings(
    val baseUrl: String = "",
    val username: String = "",
    /** JWT from `/api/login`, kept current as Frigate renews it. Empty for unauthenticated port 5000. */
    val token: String = "",
    /** The cookie Frigate sends the JWT in, `auth.cookie_name` on the server. */
    val tokenCookie: String = DEFAULT_TOKEN_COOKIE,
    /** The server uses a self-signed certificate (Frigate's port 8971 default), trusted by [certificatePin]. */
    val selfSignedCert: Boolean = false,
    /** SHA-256 fingerprint of the self-signed certificate the user accepted. */
    val certificatePin: String = "",
    /** Camera grid columns on a phone; wider screens add more. */
    val gridColumns: Int = 1,
    /** Mark an event reviewed on the server when it is opened, as the web UI does. */
    val markReviewedOnOpen: Boolean = true,
    /** Show what is still to review: counts, badges and the controls to mark items reviewed. */
    val trackReviews: Boolean = true,
    /** The color theme's id; the app's default when empty or unknown. */
    val theme: String = "",
    /** Ask for a fingerprint, face or the screen lock before showing anything. */
    val appLock: Boolean = false,
) {
    val isConfigured: Boolean get() = baseUrl.isNotBlank()

    /**
     * A session can start from these settings without signing in: a server is
     * saved, with a token, or with no login at all (port 5000).
     */
    val canResume: Boolean get() = isConfigured && (token.isNotEmpty() || username.isEmpty())

    companion object {
        const val DEFAULT_TOKEN_COOKIE = "frigate_token"
    }
}

/**
 * A WireGuard configuration imported from a file, and whether to use it when
 * the server cannot be reached directly. Not a data class, so the private key
 * in [config] never appears in `toString()`.
 */
class TunnelSettings(val config: String, val name: String, val enabled: Boolean) {
    fun copy(enabled: Boolean) = TunnelSettings(config, name, enabled)

    override fun toString() = "TunnelSettings(name=$name, enabled=$enabled)"
}

private val Context.dataStore by preferencesDataStore(name = "server")

/** Saved settings; the token is encrypted with [cipher]. */
class SettingsStore(private val dataStore: DataStore<Preferences>, private val cipher: TokenCipher) {
    private object Keys {
        val baseUrl = stringPreferencesKey("base_url")
        val username = stringPreferencesKey("username")
        val token = stringPreferencesKey("token")
        val tokenCookie = stringPreferencesKey("token_cookie")
        val selfSigned = booleanPreferencesKey("trust_all_certs")
        val certificatePin = stringPreferencesKey("certificate_pin")
        val gridColumns = intPreferencesKey("grid_columns")
        val markReviewed = booleanPreferencesKey("mark_reviewed_on_open")
        val trackReviews = booleanPreferencesKey("track_reviews")
        val theme = stringPreferencesKey("theme")
        val appLock = booleanPreferencesKey("app_lock")
        val tunnelConfig = stringPreferencesKey("tunnel_config")
        val tunnelName = stringPreferencesKey("tunnel_name")
        val tunnelEnabled = booleanPreferencesKey("tunnel_enabled")
    }

    val settings: Flow<ServerSettings> = dataStore.data.map(::read).flowOn(Dispatchers.IO)

    suspend fun save(settings: ServerSettings) {
        dataStore.edit { p -> write(p, settings) }
    }

    /**
     * Applies [change] to the settings as stored, in one transaction, so what
     * it leaves alone keeps its stored value: a preference saved by the app
     * does not put back a token the widget renewed meanwhile.
     */
    suspend fun update(change: (ServerSettings) -> ServerSettings) {
        dataStore.edit { p ->
            val stored = read(p)
            val next = change(stored)
            // Encrypting gives new bytes each time, so an unchanged token is not written again.
            write(p, next, token = next.token != stored.token)
        }
    }

    private fun read(p: Preferences) = ServerSettings(
        baseUrl = p[Keys.baseUrl].orEmpty(),
        username = p[Keys.username].orEmpty(),
        // Unreadable (the key is gone) means signed out, not a crash.
        token = p[Keys.token]?.let(cipher::decrypt).orEmpty(),
        tokenCookie = p[Keys.tokenCookie] ?: ServerSettings.DEFAULT_TOKEN_COOKIE,
        selfSignedCert = p[Keys.selfSigned] ?: false,
        certificatePin = p[Keys.certificatePin].orEmpty(),
        gridColumns = p[Keys.gridColumns] ?: 1,
        markReviewedOnOpen = p[Keys.markReviewed] ?: true,
        trackReviews = p[Keys.trackReviews] ?: true,
        theme = p[Keys.theme].orEmpty(),
        appLock = p[Keys.appLock] ?: false,
    )

    private fun write(p: MutablePreferences, settings: ServerSettings, token: Boolean = true) {
        p[Keys.baseUrl] = settings.baseUrl
        p[Keys.username] = settings.username
        if (token) p[Keys.token] = cipher.encrypt(settings.token)
        p[Keys.tokenCookie] = settings.tokenCookie
        p[Keys.selfSigned] = settings.selfSignedCert
        p[Keys.certificatePin] = settings.certificatePin
        p[Keys.gridColumns] = settings.gridColumns
        p[Keys.markReviewed] = settings.markReviewedOnOpen
        p[Keys.trackReviews] = settings.trackReviews
        p[Keys.theme] = settings.theme
        p[Keys.appLock] = settings.appLock
    }

    /** The imported WireGuard tunnel, kept apart from the server's settings and through signing out; null when there is none. */
    val tunnel: Flow<TunnelSettings?> = dataStore.data.map { p ->
        // Unreadable (the key is gone) means it has to be imported again.
        p[Keys.tunnelConfig]?.let(cipher::decrypt)?.takeIf { it.isNotEmpty() }?.let { config ->
            TunnelSettings(config, p[Keys.tunnelName].orEmpty(), p[Keys.tunnelEnabled] ?: true)
        }
    }.flowOn(Dispatchers.IO)

    /** Saves [tunnel] with its configuration, private key included, encrypted; null forgets it. */
    suspend fun saveTunnel(tunnel: TunnelSettings?) {
        dataStore.edit { p ->
            if (tunnel == null) {
                p.remove(Keys.tunnelConfig)
                p.remove(Keys.tunnelName)
                p.remove(Keys.tunnelEnabled)
            } else {
                p[Keys.tunnelConfig] = cipher.encrypt(tunnel.config)
                p[Keys.tunnelName] = tunnel.name
                p[Keys.tunnelEnabled] = tunnel.enabled
            }
        }
    }

    /** Encrypts a token saved in plain text by an earlier version of the app. */
    suspend fun encryptLegacyToken() {
        dataStore.edit { p ->
            val stored = p[Keys.token]
            if (stored != null && !cipher.isEncrypted(stored)) p[Keys.token] = cipher.encrypt(stored)
        }
    }

    suspend fun clearSession() {
        dataStore.edit { p -> p.remove(Keys.token) }
    }

    companion object {
        /** The app's settings file, with the token encrypted by a key in the Android Keystore. */
        fun create(context: Context) = SettingsStore(context.dataStore, TokenCipher.androidKeystore())
    }
}
