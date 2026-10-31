package com.jtn.frigateviewer.ui

import android.view.LayoutInflater
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.Session
import kotlinx.coroutines.delay

/** A recording's player, and why it could not play when it could not. */
internal class VodPlayback(val player: ExoPlayer) {
    var error by mutableStateOf<String?>(null)
}

/**
 * The player for [url], made once for as long as the caller stays composed, so
 * the layouts that show it can change (rotating, going fullscreen) without the
 * recording starting again from the beginning.
 */
@OptIn(UnstableApi::class)
@Composable
internal fun rememberVodPlayback(session: Session, url: String, onPosition: ((Long) -> Unit)? = null): VodPlayback {
    val context = LocalContext.current
    val newPlayer = LocalPlayerFactory.current
    val playback = remember(url) {
        val player = newPlayer(ExoPlayer.Builder(context)).apply {
            setMediaSource(
                HlsMediaSource.Factory(OkHttpDataSource.Factory(session.client)).createMediaSource(MediaItem.fromUri(url)),
            )
            playWhenReady = true
            prepare()
        }
        VodPlayback(player)
    }
    val player = playback.player
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) {
                playback.error = "This recording could not be played (${e.errorCodeName})"
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }
    PauseWhileStopped(player)
    if (onPosition != null) {
        // Milliseconds into the playlist, for a timeline to follow while it plays.
        LaunchedEffect(player) {
            while (true) {
                if (player.isPlaying) onPosition(player.currentPosition)
                delay(POSITION_INTERVAL_MS)
            }
        }
    }
    return playback
}

/** Shows [playback]'s picture, its controls, and its error if it has one. */
@Composable
internal fun VodVideo(playback: VodPlayback, modifier: Modifier = Modifier) {
    Box(modifier) {
        AndroidView(
            factory = { ctx ->
                LayoutInflater.from(ctx).inflate(R.layout.vod_player, FrameLayout(ctx), false) as PlayerView
            },
            update = { it.player = playback.player },
            // The view of the layout being left lets go, and the next one takes the picture.
            onRelease = { it.player = null },
            modifier = Modifier.fillMaxSize(),
        )
        playback.error?.let {
            Text(it, color = Palette.Alert, textAlign = TextAlign.Center, modifier = Modifier.align(Alignment.Center).padding(24.dp))
        }
    }
}

/**
 * Pauses [player] while the app is in the background or the screen is off, so a
 * recording's sound does not carry on unseen, and plays on when the app returns
 * if it was playing when it left.
 */
@Composable
private fun PauseWhileStopped(player: Player) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, player) {
        // Opened while already in the background, it waits for the app to return.
        var resume = !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && player.playWhenReady
        if (resume) player.pause()
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> {
                    resume = resume || player.playWhenReady
                    player.pause()
                }
                Lifecycle.Event.ON_START -> if (resume) {
                    resume = false
                    player.play()
                }
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
}

private const val POSITION_INTERVAL_MS = 250L
