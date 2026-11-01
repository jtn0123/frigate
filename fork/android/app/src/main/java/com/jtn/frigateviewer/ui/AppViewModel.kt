package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jtn.frigateviewer.data.AuthException
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.InsecureLoginException
import com.jtn.frigateviewer.data.MediaFiles
import com.jtn.frigateviewer.data.MotionBucket
import com.jtn.frigateviewer.data.PtzInfo
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.data.Severity
import com.jtn.frigateviewer.data.SignIn
import com.jtn.frigateviewer.data.SignInResult
import com.jtn.frigateviewer.data.allowedCameras
import com.jtn.frigateviewer.data.map
import com.jtn.frigateviewer.data.motionActivity
import com.jtn.frigateviewer.data.ptzInfo
import com.jtn.frigateviewer.data.review
import com.jtn.frigateviewer.tunnel.RemoteAccess
import java.io.IOException
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

/**
 * A self-signed certificate waiting for the user to trust it before the
 * password is sent. Not a data class, so the password never appears in
 * `toString()` and so in a log or crash report.
 */
class PendingCertificate(
    val fingerprint: String,
    /** A different certificate was trusted for this server before. */
    val changed: Boolean,
    internal val url: String,
    internal val user: String,
    internal val password: String,
) {
    override fun toString() = "PendingCertificate(fingerprint=$fingerprint, changed=$changed, url=$url)"
}

class AppViewModel(
    saved: SavedStateHandle,
    private val store: SettingsStore,
    private val signIn: SignIn = SignIn(),
    media: MediaFiles? = null,
    /** The WireGuard tunnel used away from home; null where there is none, as in tests. */
    val remoteAccess: RemoteAccess? = null,
    /** Each camera's latest picture. */
    val snapshots: Snapshots = Snapshots(),
) : ViewModel() {

    /** False until settings load, so the login screen does not flash on start. */
    var loaded by mutableStateOf(false)
        private set
    var session by mutableStateOf<Session?>(null)
        private set
    var savedSettings by mutableStateOf(ServerSettings())
        private set

    val nav = Navigator(saved)

    /**
     * Events as last seen, so an open one stays up after it ages out of the
     * 24-hour list. Observable, so an event fetched to restore a screen shows up.
     */
    private val openedEvents = mutableStateMapOf<String, ReviewItem>()

    /** IDs of open events being fetched after Android restarted the app; their screens wait for them. */
    var restoringEvents by mutableStateOf<Set<String>>(emptySet())
        private set

    var cameras by mutableStateOf<Remote<List<Camera>>>(Remote.Loading)
        private set

    /**
     * The signed-in session's work. It is cancelled when the session ends, so
     * a request still running from it cannot sign out or change the next one.
     */
    private var sessionJob = SupervisorJob(viewModelScope.coroutineContext.job)

    /** Runs work in the current session's [sessionJob], read again at each launch. */
    private val sessionScope = object : CoroutineScope {
        override val coroutineContext: CoroutineContext get() = viewModelScope.coroutineContext + sessionJob
    }

    private val reviewStore = ReviewStore(sessionScope, onSessionLost = ::sessionLost)
    val reviews get() = reviewStore.reviews
    val refreshingReviews get() = reviewStore.refreshing
    var severity by reviewStore::severity
    var cameraFilter by reviewStore::cameraFilter
    val filteredReviews get() = reviewStore.filtered
    val unreviewedAlerts get() = reviewStore.unreviewedAlerts
    val reviewsCapped get() = reviewStore.capped
    val reviewMessage get() = reviewStore.message

    /** Each camera's unreviewed count and latest item, worked out once per change of the list. */
    fun reviewSummary(camera: String): CameraSummary = reviewStore.summaries[camera] ?: CameraSummary.NONE

    fun reviewMessageShown() = reviewStore.messageShown()

    /** Clips being saved and snapshots being shared. */
    val clips = Clips(sessionScope, onSessionLost = ::sessionLost, media)

    /** The server can find tracked objects from a description. */
    var semanticSearch by mutableStateOf(false)
        private set

    /** Switching cameras' detection and recording, and moving PTZ cameras, for admins. */
    val controls = CameraControl(sessionScope, onSessionLost = ::sessionLost)

    /** Searching past the last 24 hours; kept while its results are opened. */
    val search = ReviewSearch(sessionScope, onSessionLost = ::sessionLost)

    /** The server's health, refreshed while its screen is open. */
    val health = Polled(sessionScope, onSessionLost = ::sessionLost) { it.stats() }

    /** Each camera's motion for a timeline's day. */
    val motion = RemoteCache<MotionRange, List<MotionBucket>>(sessionScope, onSessionLost = ::sessionLost) { api, range ->
        api.motionActivity(range.camera, range.from, range.to, range.scaleSeconds)
    }

    /** What each PTZ camera's motor can do. */
    val ptz = RemoteCache<String, PtzInfo>(sessionScope, onSessionLost = ::sessionLost) { api, camera -> api.ptzInfo(camera) }

    /** go2rtc streams; null when unknown, in which case live video is attempted anyway. */
    private var liveStreams by mutableStateOf<Set<String>?>(null)

    /** Frigate's version, or why it could not be read, for Settings. */
    var serverVersion by mutableStateOf<Remote<String>>(Remote.Loading)
        private set

    var loginError by mutableStateOf<String?>(null)
        private set
    var loggingIn by mutableStateOf(false)
        private set

    fun clearLoginError() {
        loginError = null
    }

    init {
        viewModelScope.launch {
            store.encryptLegacyToken()
            val settings = store.settings.first()
            savedSettings = settings
            if (settings.isConfigured && (settings.token.isNotEmpty() || settings.username.isEmpty())) {
                startSession(settings)
            }
            loaded = true
            // The widget renews the token too, while the app runs; use the newest one saved.
            store.settings.map { it.token }.distinctUntilChanged().collect { token ->
                session?.takeIf { token.isNotEmpty() && it.token != token }?.adoptToken(token)
            }
        }
        remoteAccess?.let { remote ->
            viewModelScope.launch {
                // Connections made before the tunnel went up or down will not work on the new route.
                snapshotFlow { remote.routeChanges }.drop(1).collect {
                    session?.client?.connectionPool?.evictAll()
                    if (serverVersion is Remote.Failed) loadVersion()
                    refreshCameras()
                    refreshRecentReviews()
                }
            }
        }
    }

    var pendingCertificate by mutableStateOf<PendingCertificate?>(null)
        private set

    /**
     * Signs in. For a self-signed server the certificate is checked first: an
     * unknown or changed one is shown as [pendingCertificate], and nothing is
     * sent until the user trusts it with [trustCertificate].
     */
    fun login(url: String, user: String, password: String, selfSignedCert: Boolean, trustedFingerprint: String? = null) {
        if (loggingIn) return
        loggingIn = true
        loginError = null
        viewModelScope.launch {
            try {
                when (val result = signIn.signIn(savedSettings, url, user, password, selfSignedCert, trustedFingerprint)) {
                    is SignInResult.NeedsTrust ->
                        pendingCertificate = PendingCertificate(result.fingerprint, result.changed, url, user, password)
                    is SignInResult.SignedIn -> {
                        store.save(result.settings)
                        savedSettings = result.settings
                        startSession(result.settings)
                    }
                }
            } catch (_: AuthException) {
                loginError = if (user.isBlank()) {
                    "This server requires a login. Use port 8971 with a username."
                } else {
                    "Wrong username or password"
                }
            } catch (e: InsecureLoginException) {
                loginError = e.message
            } catch (e: IOException) {
                loginError = describeError(e)
            } catch (e: IllegalArgumentException) {
                // An address that cannot be parsed, or a reply that is not Frigate's.
                loginError = describeError(e)
            } finally {
                loggingIn = false
            }
        }
    }

    /** Trusts the pending certificate and finishes signing in with it. */
    fun trustCertificate() {
        val pending = pendingCertificate ?: return
        pendingCertificate = null
        login(pending.url, pending.user, pending.password, selfSignedCert = true, trustedFingerprint = pending.fingerprint)
    }

    fun rejectCertificate() {
        pendingCertificate = null
    }

    /** Signs out here and, best effort, on the server. */
    fun logout() {
        session?.api?.let { api ->
            viewModelScope.launch {
                try {
                    api.logout()
                } catch (_: IOException) {
                    // Unreachable: the token still expires on its own.
                }
            }
        }
        endSession()
    }

    /** Forgets the session here, keeping the address for signing in again. */
    private fun endSession() {
        // At once, so nothing from this session runs on while the store is cleared.
        sessionJob.cancel()
        viewModelScope.launch {
            store.clearSession()
            savedSettings = savedSettings.copy(token = "")
            session = null
            openedEvents.clear()
            restoringEvents = emptySet()
            clips.reset()
            search.reset()
            controls.reset()
            health.reset()
            motion.reset()
            ptz.reset()
            snapshots.reset()
            nav.clear()
            nav.tab = Tab.CAMERAS
        }
    }

    fun toggleGridColumns() {
        updateSettings { it.copy(gridColumns = if (it.gridColumns == 1) 2 else 1) }
    }

    fun setMarkReviewedOnOpen(enabled: Boolean) {
        updateSettings { it.copy(markReviewedOnOpen = enabled) }
    }

    fun setTrackReviews(enabled: Boolean) {
        updateSettings { it.copy(trackReviews = enabled) }
    }

    /** The color theme, kept through signing out like the server's address. */
    val theme: AppTheme get() = AppTheme.byId(savedSettings.theme)

    fun setTheme(theme: AppTheme) {
        updateSettings { it.copy(theme = theme.id) }
    }

    /** Kept here, not in the activity, so recreating the activity does not lock the app again. */
    val lock = AppLock()

    /** Whether to ask for unlocking; like the theme, it is kept through signing out. */
    val appLock: Boolean get() = savedSettings.appLock

    fun setAppLock(enabled: Boolean) {
        updateSettings { it.copy(appLock = enabled) }
    }

    /** Whether to show review status; off for people who browse activity without reviewing it. */
    val trackReviews: Boolean get() = session?.settings?.trackReviews ?: true

    /** Saves a preference change; the session keeps its client because only preferences changed. */
    private fun updateSettings(change: (ServerSettings) -> ServerSettings) {
        val current = session ?: return
        val settings = change(current.settings)
        savedSettings = settings
        session = current.withSettings(settings)
        // Applied to the stored settings, so a token the widget renewed meanwhile is kept.
        viewModelScope.launch { store.update(change) }
    }

    fun refreshCameras() {
        val api = session?.api ?: return
        sessionScope.launch {
            if (cameras !is Remote.Ready) cameras = Remote.Loading
            val config = load(api::config)
            if (config is Remote.Ready) {
                liveStreams = config.value.liveStreams
                semanticSearch = config.value.semanticSearch
            }
            // A role limited to some cameras would only get 403s from the others.
            val allowed = if (config is Remote.Ready) api.allowedCameras() else null
            cameras = config.map { it.cameras.filter { camera -> allowed == null || camera.name in allowed } }
        }
    }

    /** The server's live feed; [App] follows it while the app is on screen. */
    val feed = LiveFeed(
        api = { session?.api },
        onReview = reviewStore::upsert,
        onCommands = { controls.commands = it },
        onReconnect = ::refreshRecentReviews,
        onSessionLost = { sessionLost(null) },
    )

    /** Fetches the whole review list, as pull to refresh and Retry do. */
    fun refreshReviews() {
        session?.api?.let(reviewStore::refresh)
    }

    /** Catches up with reviews changed lately, after a reconnect or while the live feed is down. */
    fun refreshRecentReviews() {
        session?.api?.let(reviewStore::refreshRecent)
    }

    fun hasLiveVideo(camera: Camera): Boolean = liveStreams?.contains(camera.primaryStream) ?: true

    fun cameraByName(name: String): Camera? = (cameras as? Remote.Ready)?.value?.firstOrNull { it.name == name }

    fun cameraLabel(name: String): String = cameraByName(name)?.label ?: name

    fun reviewsFor(camera: String): List<ReviewItem> = reviewStore.forCamera(camera)

    /** The current version of a review item, or the last one seen when it has left the list. */
    fun reviewById(id: String): ReviewItem? = reviewStore.byId(id) ?: openedEvents[id]

    fun openEvent(item: ReviewItem) {
        openedEvents[item.id] = item
        nav.push(Overlay.Event(item.id))
        session?.let { reviewStore.opened(it.api, item, it.settings) }
    }

    /** Replaces the open event with another (previous or next) without growing the back stack. */
    fun showEvent(item: ReviewItem) {
        openedEvents[item.id] = item
        nav.replace(Overlay.Event(item.id))
        session?.let { reviewStore.opened(it.api, item, it.settings) }
    }

    fun markAllReviewed() {
        markReviewed(filteredReviews)
    }

    fun markReviewed(item: ReviewItem) {
        markReviewed(listOf(item))
    }

    /** Marks [item] reviewed from a swipe, offering to undo it. */
    fun swipeReviewed(item: ReviewItem) {
        session?.api?.let { reviewStore.markReviewed(it, listOf(item), undoable = true) }
    }

    fun undoReview(notice: ReviewNotice) {
        session?.api?.let { reviewStore.undo(it, notice) }
    }

    /** Leaves any open screens for the Review tab, filtered to one camera and severity. */
    fun showReviews(camera: String, severity: Severity) {
        nav.clear()
        cameraFilter = camera
        this.severity = severity
        nav.tab = Tab.REVIEW
    }

    private fun markReviewed(items: List<ReviewItem>) {
        session?.api?.let { reviewStore.markReviewed(it, items) }
    }

    private fun startSession(settings: ServerSettings) {
        sessionJob.cancel()
        sessionJob = SupervisorJob(viewModelScope.coroutineContext.job)
        // Bound to this session's job: a token renewed for an ended session is not saved over the next one's.
        val ownScope = CoroutineScope(viewModelScope.coroutineContext + sessionJob)
        session = Session.saving(settings) { change -> ownScope.launch { updateSettings(change) } }
        cameras = Remote.Loading
        reviewStore.reset()
        refreshCameras()
        refreshReviews()
        session?.let { controls.loadRole(it.api) }
        loadVersion()
        restoreEvents()
    }

    /**
     * Fetches the events of screens restored after Android stopped the app. Only
     * the last 24 hours are listed, so one opened from Search would be missing.
     */
    private fun restoreEvents() {
        val api = session?.api ?: return
        val missing = nav.overlays.filterIsInstance<Overlay.Event>().map { it.reviewId }.filter { it !in openedEvents }.toSet()
        restoringEvents = missing
        missing.forEach { id ->
            sessionScope.launch {
                (load { api.review(id) } as? Remote.Ready)?.let { openedEvents[id] = it.value }
                restoringEvents = restoringEvents - id
            }
        }
    }

    private fun loadVersion() {
        val api = session?.api ?: return
        serverVersion = Remote.Loading
        sessionScope.launch { serverVersion = load(api::version) }
    }

    private suspend fun <T> load(block: suspend () -> T): Remote<T> = loadRemote(::sessionLost, block)

    /** The server stopped accepting this session; sign in again, showing [reason] if there is one. */
    private fun sessionLost(reason: String?) {
        // The server already refuses the token, or its certificate changed; nothing to revoke.
        endSession()
        loginError = reason
    }
}

/** A camera's motion between [from] and [to] (epoch seconds), in slices of [scaleSeconds]. */
data class MotionRange(val camera: String, val from: Long, val to: Long, val scaleSeconds: Int)
