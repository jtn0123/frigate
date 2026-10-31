package com.jtn.frigateviewer.tunnel

import java.net.ConnectException
import java.net.InetAddress
import java.net.SocketTimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The direct check tries each address the server's name has, as a browser would. */
class DirectRouteTest {
    private val ipv6 = InetAddress.getByName("2001:db8::5")
    private val ipv4 = InetAddress.getByName("192.0.2.5")

    @Test
    fun anAddressThatFailsIsFollowedByTheNext() {
        val tried = mutableListOf<Pair<InetAddress, Int>>()
        connectToAny(listOf(ipv6, ipv4), budgetMs = 2_000) { address, timeoutMs ->
            tried += address to timeoutMs
            if (address == ipv6) throw ConnectException("Network is unreachable")
        }
        assertEquals(listOf(ipv6, ipv4), tried.map { it.first })
        assertTrue("The first gets a share of the time, not all of it", tried[0].second <= 1_000)
    }

    @Test
    fun whenNoneAnswersTheLastFailureIsTold() {
        val failure = runCatching {
            connectToAny(listOf(ipv6, ipv4), budgetMs = 500) { address, _ ->
                throw SocketTimeoutException("no answer from ${address.hostAddress}")
            }
        }.exceptionOrNull()
        assertEquals("no answer from 192.0.2.5", failure?.message)
    }

    @Test
    fun theTimeLimitCoversEveryAttempt() {
        var attempts = 0
        val failure = runCatching {
            connectToAny(listOf(ipv6, ipv4, ipv4), budgetMs = 100) { _, timeoutMs ->
                attempts++
                Thread.sleep(timeoutMs.toLong() + 60)
                throw SocketTimeoutException("timed out")
            }
        }.exceptionOrNull()
        assertTrue(failure is SocketTimeoutException)
        assertTrue("Stopped when the time was up, after $attempts", attempts < 3)
    }
}
