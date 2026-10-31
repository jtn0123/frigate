package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.buildHttpClient
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** A live feed the server refuses ends the session instead of retrying forever. */
class LiveFeedSessionTest {
    @get:Rule val serverRule = MockWebServerRule()

    private val api by lazy { FrigateApi(buildHttpClient(null, pin = null), serverRule.server.url("/").toString()) }

    private fun feed(current: () -> FrigateApi?, onSessionLost: () -> Unit) =
        LiveFeed(current, onReview = {}, onCommands = {}, onReconnect = {}, onSessionLost = onSessionLost)

    @Test
    fun aRefusedUpgradeEndsTheSession() {
        serverRule.server.enqueue(MockResponse.Builder().code(401).build())
        var lost = 0

        runBlocking { withTimeout(5_000) { feed({ api }) { lost++ }.follow() } }

        assertEquals(1, lost)
        assertEquals("Not tried again", 1, serverRule.server.requestCount)
    }

    @Test
    fun aRefusalForASessionAlreadyReplacedLeavesTheNewOneAlone() {
        serverRule.server.enqueue(MockResponse.Builder().code(401).build())
        var current: FrigateApi? = api
        var lost = 0
        val feed = feed({ current.also { current = null } }) { lost++ }

        runBlocking { withTimeout(5_000) { feed.follow() } }

        assertEquals(0, lost)
    }
}
