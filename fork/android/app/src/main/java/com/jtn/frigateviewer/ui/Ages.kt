package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.R

/** "4m", "2h" or "3d": how long ago [seconds] was, in its largest whole unit of at least a minute. */
private fun shortAge(seconds: Long): UiText = when {
    seconds < 3600 -> uiText(R.string.age_minutes, seconds / 60)
    seconds < 86_400 -> uiText(R.string.age_hours, seconds / 3600)
    else -> uiText(R.string.age_days, seconds / 86_400)
}

/** "just now", "4m ago", "2h ago", as of [nowMillis]. */
fun timeAgo(epochSeconds: Double, nowMillis: Long = System.currentTimeMillis()): UiText {
    val seconds = (nowMillis / 1000.0 - epochSeconds).toLong()
    return if (seconds < 60) uiText(R.string.time_just_now) else uiText(R.string.time_ago, shortAge(seconds))
}

/** "now", "4m", "2h": [timeAgo] without its "ago", as of [nowMillis]. */
fun timeSince(epochSeconds: Double, nowMillis: Long = System.currentTimeMillis()): UiText {
    val seconds = (nowMillis / 1000.0 - epochSeconds).toLong()
    return if (seconds < 60) uiText(R.string.time_now) else shortAge(seconds)
}

/** "now" and "12m" within the hour of [nowMillis], then the clock time, as list rows show it. */
fun shortTime(epochSeconds: Double, nowMillis: Long = System.currentTimeMillis()): UiText {
    val seconds = (nowMillis / 1000.0 - epochSeconds).toLong()
    return when {
        seconds < 60 -> uiText(R.string.time_now)
        seconds < 3600 -> uiText(R.string.age_minutes, seconds / 60)
        else -> UiText.Plain(formatTime(epochSeconds))
    }
}
