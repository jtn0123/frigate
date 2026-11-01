package com.jtn.frigateviewer.ui

import com.jtn.frigateviewer.data.AuthException
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.buildHttpClient
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The view model's holders for a screen's own data, in virtual time. */
@OptIn(ExperimentalCoroutinesApi::class)
class RemoteHoldersTest {
    /** Never called: each fetch here answers from the test instead. */
    private val api = FrigateApi(buildHttpClient(null, pin = null), "http://frigate.invalid/")

    private val sessionLost = mutableListOf<String?>()

    /** Answers in order; an exception is thrown as the request failing. */
    private class Answers(vararg answers: Any) {
        private val left = answers.toMutableList()
        var calls = 0
            private set

        fun next(): String {
            calls++
            val answer = left.removeAt(0)
            if (answer is Exception) throw answer
            return answer.toString()
        }
    }

    private fun TestScope.polled(answers: Answers) = Polled(backgroundScope, { sessionLost += it }) { answers.next() }

    @Test
    fun followingFetchesEachIntervalAndKeepsTheLastGoodValueThroughAFailure() = runTest {
        val answers = Answers("one", IOException("down"), "two", "three")
        val health = polled(answers)
        val following = launch { health.follow(api, intervalMs = 1_000) }
        runCurrent()
        assertEquals(Remote.Ready("one"), health.value)

        advanceTimeBy(1_001)
        assertEquals("A failed refresh keeps the figures", Remote.Ready("one"), health.value)
        advanceTimeBy(1_000)
        assertEquals(Remote.Ready("two"), health.value)

        following.cancelAndJoin()
        advanceTimeBy(10_000)
        assertEquals("Leaving the screen stops it", 3, answers.calls)
    }

    @Test
    fun aFirstFailureShowsAndRetryFetchesAgainAtOnce() = runTest {
        val answers = Answers(IOException("down"), "back")
        val health = polled(answers)
        val following = launch { health.follow(api, intervalMs = 60_000) }
        runCurrent()
        assertEquals(Remote.Failed("down"), health.value)

        health.retry(api)
        assertEquals(Remote.Loading, health.value)
        runCurrent()

        assertEquals(Remote.Ready("back"), health.value)
        following.cancel()
    }

    @Test
    fun aRefusedSessionSignsOut() = runTest {
        val health = polled(Answers(AuthException("401")))
        health.retry(api)
        runCurrent()
        assertEquals(listOf<String?>(null), sessionLost)
        assertTrue(health.value is Remote.Failed)
    }

    @Test
    fun resetForgetsTheValue() = runTest {
        val health = polled(Answers("one"))
        health.retry(api)
        runCurrent()
        health.reset()
        assertEquals(Remote.Loading, health.value)
    }

    private fun TestScope.cache(answers: Answers, capacity: Int = 16) =
        RemoteCache<String, String>(backgroundScope, { sessionLost += it }, capacity) { _, key -> "$key:${answers.next()}" }

    @Test
    fun aCachedValueIsNotFetchedAgain() = runTest {
        val answers = Answers("a")
        val ptz = cache(answers)
        assertEquals(Remote.Loading, ptz["porch"])

        ptz.load(api, "porch")
        runCurrent()
        assertNull("Turning the phone asks again for what is here", ptz.load(api, "porch"))

        assertEquals(Remote.Ready("porch:a"), ptz["porch"])
        assertEquals(1, answers.calls)
    }

    @Test
    fun oneOnItsWayIsNotAskedForTwice() = runTest {
        val gate = CompletableDeferred<Unit>()
        var calls = 0
        val ptz = RemoteCache<String, String>(backgroundScope, {}) { _, key ->
            calls++
            gate.await()
            key
        }
        ptz.load(api, "porch")
        runCurrent()
        assertNull(ptz.load(api, "porch"))
        gate.complete(Unit)
        runCurrent()
        assertEquals(1, calls)
        assertEquals(Remote.Ready("porch"), ptz["porch"])
    }

    @Test
    fun aFailureIsKeptUntilRetriedOrAskedForAgain() = runTest {
        val answers = Answers(IOException("down"), "a", "b")
        val motion = cache(answers)
        motion.load(api, "yard")
        runCurrent()
        assertEquals(Remote.Failed("down"), motion["yard"])

        motion.retry(api, "yard")
        assertEquals(Remote.Loading, motion["yard"])
        runCurrent()
        assertEquals(Remote.Ready("yard:a"), motion["yard"])
        assertEquals(sessionLost, emptyList<String?>())
    }

    @Test
    fun aFailedOneIsTriedAgainWhenTheScreenOpensAgain() = runTest {
        val answers = Answers(IOException("down"), "a")
        val motion = cache(answers)
        motion.load(api, "yard")
        runCurrent()
        motion.load(api, "yard")
        runCurrent()
        assertEquals(Remote.Ready("yard:a"), motion["yard"])
    }

    @Test
    fun onlyTheNewestKeysAreKept() = runTest {
        val motion = cache(Answers("1", "2", "3"), capacity = 2)
        listOf("a", "b", "c").forEach { motion.load(api, it) }
        runCurrent()
        assertEquals(Remote.Loading, motion["a"])
        // The oldest was dropped before it asked, so the others had the first answers.
        assertEquals(Remote.Ready("b:1"), motion["b"])
        assertEquals(Remote.Ready("c:2"), motion["c"])
    }

    @Test
    fun resetDropsWhatIsOnItsWay() = runTest {
        val gate = CompletableDeferred<Unit>()
        val ptz = RemoteCache<String, String>(backgroundScope, {}) { _, key ->
            gate.await()
            key
        }
        val job: Job = ptz.load(api, "porch")!!
        runCurrent()
        ptz.reset()
        gate.complete(Unit)
        runCurrent()
        assertTrue(job.isCancelled)
        assertEquals("A new session starts afresh", Remote.Loading, ptz["porch"])
    }
}
