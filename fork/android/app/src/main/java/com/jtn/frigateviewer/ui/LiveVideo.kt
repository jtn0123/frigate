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
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
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
 * instead, and [onState] reports FAILED so the caller can say so.
 */
@OptIn(UnstableApi::class)
@Composable
fun LiveVideo(
    session: Session,
    camera: String,
    stream: String,
    muted: Boolean,
    modifier: Modifier = Modifier,
    onState: (LiveState) -> Unit = {},
) {
    val context = LocalContext.current
    val retry = remember(stream) { LiveRetry() }
    val state = retry.state

    LaunchedEffect(state) { onState(state) }

    val player = remember(stream, retry.attempt, retry.restarts) {
        val extractors = ExtractorsFactory { arrayOf(FragmentedMp4Extractor(SubtitleParser.Factory.UNSUPPORTED, 0)) }
        val source = ProgressiveMediaSource.Factory(MseDataSource.Factory(session.client), extractors)
            .createMediaSource(MediaItem.fromUri(session.api.liveUrl(stream)))
        // Small buffers: a live view should show now, not five seconds ago.
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(1_000, 4_000, 250, 500)
            .build()
        ExoPlayer.Builder(context).setLoadControl(loadControl).build().apply {
            setMediaSource(source)
            playWhenReady = true
            prepare()
        }
    }

    // Give the network a moment before reconnecting rather than failing again at once.
    LaunchedEffect(retry.pendingRetry) {
        if (retry.pendingRetry) {
            delay(LiveRetry.RETRY_DELAY_MS)
            retry.retry()
        }
    }

    LaunchedEffect(player, muted) { player.volume = if (muted) 0f else 1f }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onRenderedFirstFrame() = retry.played()

            override fun onPlayerError(error: PlaybackException) = retry.failed()
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
    val lifecycle = LocalLifecycleOwner.current.lifecycle
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
        key(player) {
            AndroidView(
                factory = { ctx -> TextureView(ctx).also { player.setVideoTextureView(it) } },
                update = { view -> view.alpha = if (playing) 1f else 0f },
                modifier = Modifier.fillMaxSize(),
            )
        }
        if (state == LiveState.CONNECTING) {
            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp, color = Color.White)
        }
    }
}
