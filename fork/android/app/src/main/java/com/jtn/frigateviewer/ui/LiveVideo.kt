package com.jtn.frigateviewer.ui

import android.view.TextureView
import androidx.annotation.OptIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.mp4.FragmentedMp4Extractor
import androidx.media3.extractor.text.SubtitleParser
import com.jtn.frigateviewer.data.MseDataSource
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.liveUrl
import kotlinx.coroutines.delay

/**
 * Real-time video from go2rtc over Frigate's MSE WebSocket.
 *
 * The latest snapshot shows immediately and stays underneath until the first
 * video frame renders, so the view is never an empty black box. If the
 * stream cannot start after a couple of retries the snapshot keeps refreshing
 * instead, and [onState] reports FAILED so the caller can say so. When
 * [route] changes, as when the tunnel or another VPN comes up or goes down,
 * the stream starts again on the new way to the server, with every retry.
 *
 * The screen stays on while the video plays. Sound takes audio focus only
 * while it is not [muted], so a grid of muted tiles leaves music playing; if
 * another app takes the sound, or headphones come out, the picture plays on
 * silently instead of freezing. A stream the server refuses as unauthorized
 * ends the session, as [LocalSessionLost] says.
 */
@OptIn(UnstableApi::class)
@Composable
fun LiveVideo(
    session: Session,
    camera: String,
    stream: String,
    muted: Boolean,
    modifier: Modifier = Modifier,
    route: Int = 0,
    onState: (LiveState) -> Unit = {},
) {
    val context = LocalContext.current
    val retry = remember(stream) { LiveRetry() }
    // The open stream, or the one that gave up, was on the old way to the server.
    var streamRoute by remember(stream) { mutableIntStateOf(route) }
    LaunchedEffect(route) {
        if (route != streamRoute) {
            streamRoute = route
            retry.resumed()
        }
    }
    val state = retry.state
    val newPlayer = LocalPlayerFactory.current
    val sessionLost by rememberUpdatedState(LocalSessionLost.current)
    // Another app took the sound, or headphones came out: silent until the mute is next changed.
    var silenced by remember(stream) { mutableStateOf(false) }
    LaunchedEffect(muted) { silenced = false }

    LaunchedEffect(state) { onState(state) }

    val player = remember(stream, retry.attempt, retry.restarts) {
        val extractors = ExtractorsFactory { arrayOf(FragmentedMp4Extractor(SubtitleParser.Factory.UNSUPPORTED, 0)) }
        val source = ProgressiveMediaSource.Factory(MseDataSource.Factory(session.client), extractors)
            .createMediaSource(MediaItem.fromUri(session.api.liveUrl(stream)))
        // Small buffers: a live view should show now, not five seconds ago.
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(1_000, 4_000, 250, 500)
            .build()
        // Audio focus follows the mute, below.
        val builder = ExoPlayer.Builder(context).setLoadControl(loadControl).setAudioAttributes(VideoAudio, false)
        newPlayer(builder).apply {
            setMediaSource(source)
            playWhenReady = true
            prepare()
        }
    }

    val lifecycle = LocalLifecycleOwner.current.lifecycle

    // Give the network a moment before reconnecting rather than failing again at once.
    // Not in the background, where the new player would play unseen: returning starts one.
    LaunchedEffect(retry.pendingRetry) {
        if (retry.pendingRetry) {
            delay(LiveRetry.RETRY_DELAY_MS)
            if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) retry.retry()
        }
    }

    LaunchedEffect(player, muted, silenced) {
        val audible = !muted && !silenced
        player.volume = if (audible) 1f else 0f
        player.setAudioAttributes(VideoAudio, audible)
        player.setHandleAudioBecomingNoisy(audible)
        // Given up the sound, so playing on cannot take it back.
        if (silenced) player.play()
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onRenderedFirstFrame() = retry.played()

            override fun onPlayerError(error: PlaybackException) {
                if (refusesSession(error)) sessionLost()
                retry.failed()
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!playWhenReady && reason in SOUND_TAKEN) silenced = true
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }

    // Close the stream while the app is in the background so it stops using
    // data and battery, and reconnect on return so the picture is live again
    // rather than resuming from where it stopped.
    val currentPlayer by rememberUpdatedState(player)
    DisposableEffect(lifecycle, retry) {
        var stopped = false
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> {
                    stopped = true
                    currentPlayer.stop()
                }
                Lifecycle.Event.ON_START -> if (stopped) {
                    stopped = false
                    retry.resumed()
                }
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    // Data arrives in real time, so any backlog is latency. Play slightly
    // fast until the buffer drains rather than drifting further behind.
    LaunchedEffect(player) {
        while (true) {
            delay(1_000)
            val behind = player.bufferedPosition - player.currentPosition
            val speed = when {
                behind > 3_000 -> 1.5f
                behind > 1_200 -> 1.15f
                else -> 1f
            }
            if (player.playbackParameters.speed != speed) player.playbackParameters = PlaybackParameters(speed)
        }
    }

    Box(modifier, contentAlignment = Alignment.Center) {
        // Snapshots only while the video is not showing; the last one stays
        // underneath so a reconnect never flashes black.
        LiveFrame(
            api = session.api,
            camera = camera,
            intervalMs = if (state == LiveState.FAILED) 1_000 else 3_000,
            height = 720,
            modifier = Modifier.fillMaxSize(),
            active = state != LiveState.PLAYING,
        )
        // One surface for the player's whole life, hidden until the first frame
        // renders so the snapshot shows through instead of a black rectangle.
        val playing = state == LiveState.PLAYING
        val moving = rememberIsPlaying(player)
        key(player) {
            AndroidView(
                factory = { ctx -> TextureView(ctx).also { player.setVideoTextureView(it) } },
                update = { view ->
                    view.alpha = if (playing) 1f else 0f
                    // Not while it reconnects, stalls or has given up.
                    view.keepScreenOn = playing && moving
                },
                modifier = Modifier.fillMaxSize(),
            )
        }
        if (state == LiveState.CONNECTING) {
            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp, color = Color.White)
        }
    }
}

/** Why a player stops itself when its sound is no longer wanted. */
private val SOUND_TAKEN = setOf(
    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS,
    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY,
)
