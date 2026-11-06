package com.jtn.frigateviewer.ui

import android.view.LayoutInflater
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
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
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.Session
import java.net.HttpURLConnection.HTTP_BAD_GATEWAY
import java.net.HttpURLConnection.HTTP_FORBIDDEN
import java.net.HttpURLConnection.HTTP_NOT_FOUND
import java.net.HttpURLConnection.HTTP_UNAUTHORIZED
import kotlinx.coroutines.delay

/** A recording's player, and why it could not play when it could not. */
internal class VodPlayback(val player: ExoPlayer) {
    var error by mutableStateOf<UiText?>(null)

    /** Tries again from where it stopped. */
    fun retry() {
        error = null
        player.prepare()
        player.play()
    }
}

/** Why a recording could not play, in plain words rather than ExoPlayer's error code. */
@OptIn(UnstableApi::class)
internal fun playbackError(e: PlaybackException): UiText {
    val status = (e.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode
    return when {
        status == HTTP_NOT_FOUND -> uiText(R.string.cam_vod_not_found)
        // The login expired; the session ends with it, as [LocalSessionLost] says.
        status == HTTP_UNAUTHORIZED -> uiText(R.string.failure_session_expired)
        // A permission, not the login: this account may not see the camera.
        status == HTTP_FORBIDDEN -> uiText(R.string.cam_vod_refused)
        // nginx-vod's answer when it cannot put the clip together from the saved segments.
        status == HTTP_BAD_GATEWAY -> uiText(R.string.cam_vod_unassembled)
        status != null || e.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ->
            uiText(R.string.cam_vod_server_error)
        e.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
            e.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ||
            e.errorCode == PlaybackException.ERROR_CODE_TIMEOUT -> uiText(R.string.cam_vod_offline)
        else -> uiText(R.string.cam_vod_failed)
    }
}

/**
 * Where a recording had got to, kept through the activity being made again (a
 * dark mode or font size change), another screen pushed over this one, and the
 * app's process being stopped in the background.
 */
internal class VodResume(var positionMs: Long = 0) {
    /** The player while it is open, read at the moment the position is saved. */
    var player: Player? = null

    fun save(): Long = player?.currentPosition ?: positionMs

    companion object {
        val Saver = Saver<VodResume, Long>(save = { it.save() }, restore = { VodResume(it) })
    }
}

/**
 * The player for [url], made once for as long as the caller stays composed, so
 * the layouts that show it can change (rotating, going fullscreen) without the
 * recording starting again from the beginning. A player made again for the
 * same [url] carries on from where the last one was. A recording the server
 * refuses as unauthorized ends the session, as [LocalSessionLost] says.
 */
@OptIn(UnstableApi::class)
@Composable
internal fun rememberVodPlayback(session: Session, url: String, onPosition: ((Long) -> Unit)? = null): VodPlayback {
    val context = LocalContext.current
    val newPlayer = LocalPlayerFactory.current
    val sessionLost by rememberUpdatedState(LocalSessionLost.current)
    val resume = rememberSaveable(url, saver = VodResume.Saver) { VodResume() }
    val playback = remember(url) {
        val builder = ExoPlayer.Builder(context)
            .setAudioAttributes(VideoAudio, true)
            .setHandleAudioBecomingNoisy(true)
        val player = newPlayer(builder).apply {
            setMediaSource(
                HlsMediaSource.Factory(OkHttpDataSource.Factory(session.client)).createMediaSource(MediaItem.fromUri(url)),
            )
            if (resume.positionMs > 0) seekTo(resume.positionMs)
            playWhenReady = true
            prepare()
        }
        VodPlayback(player)
    }
    val player = playback.player
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) {
                if (refusesSession(e)) sessionLost()
                playback.error = playbackError(e)
            }
        }
        player.addListener(listener)
        resume.player = player
        onDispose {
            // Before it is released, while it still knows where it was.
            resume.positionMs = player.currentPosition
            resume.player = null
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

/**
 * Shows [playback]'s picture, its controls, and its error if it has one. An error
 * takes the controls' place: they are hidden, and the reason and a Retry button
 * sit centered on a dark scrim, so neither is drawn over the play button.
 * The screen stays on while it plays, and may time out once it is paused.
 */
@Composable
internal fun VodVideo(playback: VodPlayback, modifier: Modifier = Modifier) {
    val error = playback.error
    val playing = rememberIsPlaying(playback.player)
    Box(modifier) {
        AndroidView(
            factory = { ctx ->
                LayoutInflater.from(ctx).inflate(R.layout.vod_player, FrameLayout(ctx), false) as PlayerView
            },
            update = {
                it.player = playback.player
                // Play and seek do nothing for a player that failed; Retry is the way on.
                it.useController = error == null
                it.keepScreenOn = playing && error == null
            },
            // The view of the layout being left lets go, and the next one takes the picture.
            onRelease = { it.player = null },
            modifier = Modifier.fillMaxSize(),
        )
        if (error != null) VodError(error, onRetry = playback::retry, Modifier.fillMaxSize())
    }
}

/** Why the recording stopped and a way to try again, legible over any picture. */
@Composable
internal fun VodError(error: UiText, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.background(Color.Black.copy(alpha = SCRIM_ALPHA)), contentAlignment = Alignment.Center) {
        Column(
            Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = Palette.Alert, modifier = Modifier.size(32.dp))
            Text(
                error.resolve(),
                color = Color.White,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
            )
            Button(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.retry)) }
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

/** Dark enough for white text over a bright picture, light enough to still see it. */
private const val SCRIM_ALPHA = 0.72f
