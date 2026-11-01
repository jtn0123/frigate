package com.jtn.frigateviewer.data

import okhttp3.OkHttpClient

/** A connected server: its settings and the client built from them. */
class Session private constructor(val settings: ServerSettings, private val auth: AuthToken, val client: OkHttpClient) {
    private constructor(settings: ServerSettings, auth: AuthToken) : this(
        settings,
        auth,
        // With no saved pin a self-signed server is not trusted; signing in again shows its certificate.
        buildHttpClient(auth, if (settings.selfSignedCert) CertificatePin(settings.certificatePin) else null),
    )

    /** [onTokenRenewed] receives each token Frigate issues in place of an expiring one. */
    constructor(
        settings: ServerSettings,
        onTokenRenewed: (String) -> Unit = {},
    ) : this(settings, AuthToken(settings.baseUrl, settings.tokenCookie, settings.token, onTokenRenewed))

    val api = FrigateApi(client, settings.baseUrl)

    fun withSettings(settings: ServerSettings) = Session(settings, auth, client)

    /** The token currently sent, which renewals replace. */
    val token: String get() = auth.current

    /** Sends [token] from now on: one the widget renewed and saved while this session ran. */
    fun adoptToken(token: String) = auth.adopt(token)

    companion object {
        /**
         * A session that hands each renewed token to [update] for saving, so
         * the next launch does not start with an expired one. Renewals arrive
         * on OkHttp's threads.
         */
        fun saving(settings: ServerSettings, update: (change: (ServerSettings) -> ServerSettings) -> Unit) = Session(
            settings,
            onTokenRenewed = { token -> update { it.copy(token = token) } },
        )
    }
}
