package com.jtn.frigateviewer.data

/* Addresses of the server's pictures and video, for the players and image loader. */

/** Review thumbnails are served from the clips directory nginx exposes. */
fun FrigateApi.thumbnailUrl(item: ReviewItem): String =
    url(item.thumbPath.removePrefix("/media/frigate/").trimStart('/')).toString()

/** HLS playlist of recordings for a time range (epoch seconds). */
fun FrigateApi.vodUrl(camera: String, start: Long, end: Long): String =
    url("vod/$camera/start/$start/end/$end/index.m3u8").toString()

fun FrigateApi.reviewVodUrl(item: ReviewItem, paddingSeconds: Long = 5): String {
    val end = item.endTime ?: (System.currentTimeMillis() / 1000.0)
    return vodUrl(item.camera, item.startTime.toLong() - paddingSeconds, end.toLong() + paddingSeconds)
}

/**
 * go2rtc's MSE WebSocket, proxied and authenticated by Frigate's nginx at
 * the same path the web UI and the Home Assistant card use.
 */
fun FrigateApi.liveUrl(stream: String): String {
    val url = base.newBuilder().addPathSegments("live/mse/api/ws").addQueryParameter("src", stream).build()
    return url.toString().replaceFirst("http", "ws")
}
