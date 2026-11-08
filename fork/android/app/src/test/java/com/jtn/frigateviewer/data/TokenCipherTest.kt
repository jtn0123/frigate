package com.jtn.frigateviewer.data

import java.security.ProviderException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.KeyGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenCipherTest {
    private fun newKey() = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val key = newKey()
    private val cipher = TokenCipher { key }
    private val token = "eyJhbGciOiJIUzI1NiJ9.payload.signature"

    private companion object {
        const val CALLERS = 8
        val WAITING = setOf(Thread.State.BLOCKED, Thread.State.WAITING, Thread.State.TIMED_WAITING)
    }

    @Test
    fun roundTripsWithoutStoringTheToken() {
        val stored = cipher.encrypt(token)
        assertFalse(stored.contains("payload"))
        assertNotEquals("A fresh IV each time", stored, cipher.encrypt(token))
        assertEquals(token, cipher.decrypt(stored))
    }

    @Test
    fun aTokenSavedBeforeEncryptionStillReads() {
        assertEquals(token, cipher.decrypt(token))
        assertFalse(cipher.isEncrypted(token))
        assertTrue(cipher.isEncrypted(cipher.encrypt(token)))
        assertEquals("", cipher.encrypt(""))
    }

    @Test
    fun theKeyIsLookedUpOnceNotOnEveryRead() {
        val loads = AtomicInteger()
        val counted = TokenCipher { key.also { loads.incrementAndGet() } }
        val stored = counted.encrypt(token)
        repeat(20) { assertEquals(token, counted.decrypt(stored)) }
        assertEquals(1, loads.get())
        // Data the key does not open says nothing about the key.
        assertNull(counted.decrypt(cipher.encrypt(token).dropLast(4) + "AAAA"))
        counted.decrypt(stored)
        assertEquals(1, loads.get())
    }

    @Test
    fun callersAtOnceMakeTheKeyOnce() {
        val loads = AtomicInteger()
        val release = CountDownLatch(1)
        val held = TokenCipher {
            loads.incrementAndGet()
            release.await(5, TimeUnit.SECONDS)
            key
        }
        val stored = arrayOfNulls<String>(CALLERS)
        val callers = List(CALLERS) { i -> Thread { stored[i] = held.encrypt(token) }.apply { start() } }
        // Every caller is either making the key or waiting for it before it is released.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (callers.count { it.state in WAITING } < CALLERS) {
            check(System.nanoTime() < deadline) { "Callers did not all arrive" }
            Thread.yield()
        }
        release.countDown()
        callers.forEach { it.join(TimeUnit.SECONDS.toMillis(5)) }

        assertEquals("Made once, not by each caller", 1, loads.get())
        stored.forEach { assertEquals(token, cipher.decrypt(it!!)) }
    }

    @Test
    fun aFailingKeystoreReadsAndSavesAsSignedOutAndIsAskedAgain() {
        listOf(ProviderException("Keystore operation failed"), IllegalStateException("Keystore locked")).forEach { failure ->
            val loads = AtomicInteger()
            val failing = TokenCipher {
                if (loads.incrementAndGet() == 1) throw failure
                key
            }
            val stored = cipher.encrypt(token)

            assertEquals("Saved as signed out, not a crash", "", failing.encrypt(token))
            assertEquals("Recovered: looked up again", token, failing.decrypt(stored))
            assertEquals(2, loads.get())
        }
        val broken = TokenCipher { throw ProviderException("Keystore operation failed") }
        assertNull(broken.decrypt(cipher.encrypt(token)))
    }

    @Test
    fun anotherKeyOrDamagedDataReadsAsNoToken() {
        val stored = cipher.encrypt(token)
        assertNull(TokenCipher { newKey() }.decrypt(stored))
        assertNull(cipher.decrypt(stored.dropLast(4) + "AAAA"))
        assertNull(cipher.decrypt("v1:not base64!"))
        assertNull("Too short for its IV", cipher.decrypt("v1:AAAA"))
    }
}
