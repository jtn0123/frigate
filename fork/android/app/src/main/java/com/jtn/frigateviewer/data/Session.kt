package com.jtn.frigateviewer.data

import okhttp3.OkHttpClient

/** A connected server: its settings and the client built from them. */
class Session private constructor(val settings: ServerSettings, private val auth: AuthToken, val client: OkHttpClient) {
    private constructor(settings: ServerSettings, auth: AuthToken, onCertificatePinned: (String) -> Unit) : this(
        settings,
        auth,
        buildHttpClient(auth, if (settings.selfSignedCert) CertificatePin(settings.certificatePin, onCertificatePinned) else null),
    )

    /**
     * [onTokenRenewed] receives each token Frigate issues in place of an
     * expiring one, and [onCertificatePinned] the fingerprint of a self-signed
     * certificate trusted on first use because none was saved.
     */
    constructor(
        settings: ServerSettings,
        onTokenRenewed: (String) -> Unit = {},
        onCertificatePinned: (String) -> Unit = {},
    ) : this(settings, AuthToken(settings.baseUrl, settings.tokenCookie, settings.token, onTokenRenewed), onCertificatePinned)

    val api = FrigateApi(client, settings.baseUrl)

    fun withSettings(settings: ServerSettings) = Session(settings, auth, client)

    /** The token currently sent, which renewals replace. */
    val token: String get() = auth.current

    /** Sends [token] from now on: one the widget renewed and saved while this session ran. */
    fun adoptToken(token: String) = auth.adopt(token)

    companion object {
        /**
         * A session that hands what the server changes to [update] for saving:
         * each renewed token, so the next launch does not start with an expired
         * one, and the certificate of an install from before pinning, trusted on
         * first use. Both arrive on OkHttp's threads.
         */
        fun saving(settings: ServerSettings, update: (change: (ServerSettings) -> ServerSettings) -> Unit) = Session(
            settings,
            onTokenRenewed = { token -> update { it.copy(token = token) } },
            onCertificatePinned = { pin -> update { it.copy(certificatePin = pin) } },
        )
    }
}
