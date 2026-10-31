package com.jtn.frigateviewer.ui

import android.content.ClipData
import android.content.Intent
import android.text.format.DateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.outlined.EventBusy
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.VideoLibrary
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import coil3.ImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import com.jtn.frigateviewer.data.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun App(vm: AppViewModel) {
    // The 12/24-hour setting can change while the app is away, so it is read again on each return.
    val context = LocalContext.current
    LifecycleStartEffect(context) {
        use24HourClock = DateFormat.is24HourFormat(context)
        onStopOrDispose {}
    }
    Surface(Modifier.fillMaxSize()) {
        val session = vm.session
        when {
            !vm.loaded -> Box(Modifier.fillMaxSize())
            session == null -> LoginScreen(vm)
            else -> SignedIn(vm, session)
        }
    }
}

@Composable
private fun SignedIn(vm: AppViewModel, session: Session) {
    val context = LocalContext.current
    // Thumbnails go through the session's client so they carry the login token.
    val imageLoader = remember(session.client) {
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { session.client })) }
            .build()
    }

    BackHandler(enabled = vm.nav.overlays.isNotEmpty()) { vm.nav.back() }

    // Keep counts and badges current while the app is on screen: the live feed
    // pushes changes as they happen, and polling stands in while it is down.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Also restarted when the tunnel goes up or down, since the open feed is on the old route.
    LaunchedEffect(session.client, vm.remoteAccess?.routeChanges) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            launch { vm.feed.follow() }
            while (true) {
                delay(60_000)
                if (!vm.feed.connected) vm.refreshReviews()
            }
        }
    }

    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm.reviewMessage) {
        vm.reviewMessage?.let { notice ->
            val undoable = notice.undoIds.isNotEmpty()
            val result = snackbar.showSnackbar(
                notice.text,
                actionLabel = if (undoable) "Undo" else null,
                withDismissAction = !undoable,
                duration = if (undoable) SnackbarDuration.Short else SnackbarDuration.Long,
            )
            vm.reviewMessageShown()
            if (result == SnackbarResult.ActionPerformed) vm.undoReview(notice)
        }
    }

    LaunchedEffect(vm.clips.notice) {
        vm.clips.notice?.let { text ->
            vm.clips.noticeShown()
            snackbar.showSnackbar(text, withDismissAction = true, duration = SnackbarDuration.Long)
        }
    }
    ShareSheet(vm.clips.share, onShown = { vm.clips.shared() })

    Box(Modifier.fillMaxSize()) {
        ProvideTickingNow { Screens(vm, session, imageLoader) }
        SnackbarHost(
            snackbar,
            Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                // Clear the bottom bar on the tabs.
                .padding(bottom = if (vm.nav.overlays.isEmpty()) 80.dp else 0.dp),
        ) { data ->
            // A floating, rounded toast like T3 Code's, lifted off the sheet.
            Snackbar(
                data,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
                shape = RoundedCornerShape(26.dp),
                containerColor = Palette.SurfaceHigh,
                contentColor = Palette.TextPrimary,
                actionColor = Palette.AccentText,
                dismissActionContentColor = Palette.TextSecondary,
            )
        }
    }
}

@Composable
private fun Screens(vm: AppViewModel, session: Session, imageLoader: ImageLoader) {
    // Each screen keeps what it saves (its scroll, folded days, the stream chosen) while
    // others are pushed over it, and forgets it once closed, so opening it again starts afresh.
    val states = rememberSaveableStateHolder()
    val keys = vm.nav.overlays.mapIndexed { index, overlay -> "$index:$overlay" }
    val composed = remember { mutableSetOf<String>() }
    LaunchedEffect(keys) {
        (composed - keys.toSet()).forEach(states::removeState)
        composed.retainAll(keys.toSet())
        composed += keys
    }
    val overlay = vm.nav.overlays.lastOrNull()
    states.SaveableStateProvider(keys.lastOrNull() ?: "tabs") {
        if (overlay == null) Tabs(vm, session, imageLoader) else OverlayScreen(vm, session, imageLoader, overlay)
    }
}

@Composable
private fun OverlayScreen(vm: AppViewModel, session: Session, imageLoader: ImageLoader, overlay: Overlay) {
    when (overlay) {
        is Overlay.CameraDetail -> vm.cameraByName(overlay.camera)
            ?.let { CameraDetailScreen(vm, session, it, imageLoader) }
            ?: Unavailable(vm, vm.cameras, onRetry = vm::refreshCameras)
        is Overlay.Event -> vm.reviewById(overlay.reviewId)
            ?.let { EventScreen(vm, session, it) }
            // An event open before a restart may still be on its way back from the server.
            ?: Unavailable(
                vm,
                if (overlay.reviewId in vm.restoringEvents) Remote.Loading else vm.reviews,
                onRetry = vm::refreshReviews,
            )
        is Overlay.Recording -> vm.cameraByName(overlay.camera)
            ?.let { RecordingScreen(vm, session, it, overlay.minutes, overlay.end) }
            ?: Unavailable(vm, vm.cameras, onRetry = vm::refreshCameras)
        is Overlay.Timeline -> vm.cameraByName(overlay.camera)
            ?.let { TimelineScreen(vm, session, it, overlay.start) }
            ?: Unavailable(vm, vm.cameras, onRetry = vm::refreshCameras)
        is Overlay.LiveGrid -> LiveGridScreen(vm, session, overlay.cameras)
        Overlay.Health -> HealthScreen(vm)
        Overlay.TunnelLog -> vm.remoteAccess?.let { TunnelLogScreen(vm, it) } ?: Unavailable(vm, source = null)
        Overlay.Search -> SearchScreen(vm, session, imageLoader)
    }
}

/** The tabs and the bar to switch between them; each tab keeps its state while another shows. */
@Composable
private fun Tabs(vm: AppViewModel, session: Session, imageLoader: ImageLoader) {
    val states = rememberSaveableStateHolder()
    Scaffold(
        bottomBar = {
            NavigationBar(containerColor = Palette.Chrome) {
                Tab.entries.forEach { tab ->
                    val selected = vm.nav.tab == tab
                    NavigationBarItem(
                        selected = selected,
                        onClick = { vm.nav.tab = tab },
                        icon = {
                            val badge = if (tab == Tab.REVIEW && vm.trackReviews) vm.unreviewedAlerts else 0
                            BadgedBox(badge = { if (badge > 0) Badge { Text(if (badge > 99) "99+" else "$badge") } }) {
                                Icon(tab.icon(selected), contentDescription = null)
                            }
                        },
                        label = { Text(tab.title) },
                        colors = NavigationBarItemDefaults.colors(indicatorColor = Palette.Outline),
                    )
                }
            }
        },
    ) { padding ->
        // Only the bottom bar's space is taken here; each screen pads for the status bar itself.
        // The header band shares the bottom bar's color, so each tab's sheet sits framed between them.
        Box(Modifier.fillMaxSize().background(Palette.Chrome).padding(bottom = padding.calculateBottomPadding())) {
            states.SaveableStateProvider(vm.nav.tab.name) {
                when (vm.nav.tab) {
                    Tab.CAMERAS -> CamerasScreen(vm, session)
                    Tab.REVIEW -> ReviewScreen(vm, session, imageLoader)
                    Tab.SETTINGS -> SettingsScreen(vm, session)
                }
            }
        }
    }
}

/** Opens the share sheet for [request], once. */
@Composable
private fun ShareSheet(request: ShareRequest?, onShown: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(request) {
        request ?: return@LaunchedEffect
        onShown()
        val uri = request.uri.toUri()
        val send = Intent(Intent.ACTION_SEND)
            .setType(request.mime)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // The clip data carries the read grant through the chooser to the app picked.
        send.clipData = ClipData.newRawUri(null, uri)
        context.startActivity(Intent.createChooser(send, null))
    }
}

/**
 * A restored screen whose camera or event is not in [source], the list it comes from:
 * still loading, failed to load (with the reason and a retry), or gone from the server.
 */
@Composable
private fun Unavailable(vm: AppViewModel, source: Remote<*>?, onRetry: () -> Unit = {}) {
    Column(Modifier.fillMaxSize()) {
        IconButton(onClick = { vm.nav.back() }, modifier = Modifier.statusBarsPadding().padding(start = 4.dp, top = 4.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
        }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            when (source) {
                Remote.Loading -> CircularProgressIndicator()
                // The list did not load, so whether it is still there is not known yet.
                is Remote.Failed -> RemoteContent(source, onRetry = onRetry) {}
                else -> EmptyState(
                    Icons.Outlined.EventBusy,
                    "This is no longer available",
                    detail = "It may have been deleted, or aged out of what the server keeps.",
                    action = EmptyAction("Go back") { vm.nav.back() },
                )
            }
        }
    }
}

private val Tab.title: String
    get() = when (this) {
        Tab.CAMERAS -> "Cameras"
        Tab.REVIEW -> "Review"
        Tab.SETTINGS -> "Settings"
    }

private fun Tab.icon(selected: Boolean): ImageVector = when (this) {
    Tab.CAMERAS -> if (selected) Icons.Filled.Videocam else Icons.Outlined.Videocam
    Tab.REVIEW -> if (selected) Icons.Filled.VideoLibrary else Icons.Outlined.VideoLibrary
    Tab.SETTINGS -> if (selected) Icons.Filled.Settings else Icons.Outlined.Settings
}
